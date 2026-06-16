import type { DecisionStrategy } from '../../domain/decision/DecisionStrategy.js';
import type { MarketHours } from '../../domain/market/MarketHours.js';
import type { Bar } from '../../domain/marketdata/MarketDataTypes.js';
import type { MetricsPort } from '../../domain/metrics/MetricsPort.js';
import { CacheUnderfilledError } from '../../domain/indicators/IndicatorErrors.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { errMsg } from '../../shared/errors.js';
import type { PlaceBracketOrder } from '../broker/PlaceBracketOrder.js';
import type { PlaceLimitOrder } from '../broker/PlaceLimitOrder.js';
import type { CheckOpenTrades } from '../trade/CheckOpenTrades.js';
import type { CheckSyntheticStops } from '../trade/CheckSyntheticStops.js';
import type { MaybeMoveStopToBreakEven } from '../trade/MaybeMoveStopToBreakEven.js';
import type { MaybeRepegSyntheticExit } from '../trade/MaybeRepegSyntheticExit.js';
import type { MaybeTrailStopAlongEma } from '../trade/MaybeTrailStopAlongEma.js';
import type { MaybeTrailSyntheticStop } from '../trade/MaybeTrailSyntheticStop.js';
import type { ReconcileEntryFill } from '../trade/ReconcileEntryFill.js';
import type { RecordTradeContext } from '../trade/RecordTradeContext.js';

const log = logger.child({ component: 'StrategyEvaluator' });

type BuySignal = Extract<
  ReturnType<DecisionStrategy['model']['evaluate']>,
  { action: 'buy' }
>;

export interface StrategyEvaluatorOptions {
  strategies: DecisionStrategy[];
  placeBracketOrder: PlaceBracketOrder;
  recordTradeContext: RecordTradeContext;
  reconcileEntryFill: ReconcileEntryFill;
  checkOpenTrades: CheckOpenTrades;
  maybeMoveStopToBreakEven?: MaybeMoveStopToBreakEven;
  marketHours: MarketHours;
  metrics: MetricsPort;
  placeLimitOrder?: PlaceLimitOrder;
  checkSyntheticStops?: CheckSyntheticStops;
  maybeTrailSyntheticStop?: MaybeTrailSyntheticStop;
  maybeRepegSyntheticExit?: MaybeRepegSyntheticExit;
  maybeTrailStopAlongEma?: MaybeTrailStopAlongEma;
  now?: () => number;
  // Invocado cuando una evaluación falla con CacheUnderfilledError, para que
  // el dueño del cache (SymbolSubscriptionService) re-bootstrapee el símbolo.
  recoverCache: (symbol: string) => void;
}

// Corre las estrategias y stops sintéticos sobre cada barra cerrada de un
// símbolo suscrito. El BarStreamManager le pasa la barra ya ingerida en cache
// (vía SymbolSubscriptionService) cuando corresponde evaluar.
export class StrategyEvaluator {
  private readonly strategies: DecisionStrategy[];
  private readonly placeBracketOrder: PlaceBracketOrder;
  private readonly recordTradeContext: RecordTradeContext;
  private readonly reconcileEntryFill: ReconcileEntryFill;
  private readonly checkOpenTrades: CheckOpenTrades;
  private readonly maybeMoveStopToBreakEven?: MaybeMoveStopToBreakEven;
  private readonly marketHours: MarketHours;
  private readonly metrics: MetricsPort;
  private readonly placeLimitOrder?: PlaceLimitOrder;
  private readonly checkSyntheticStops?: CheckSyntheticStops;
  private readonly maybeTrailSyntheticStop?: MaybeTrailSyntheticStop;
  private readonly maybeRepegSyntheticExit?: MaybeRepegSyntheticExit;
  private readonly maybeTrailStopAlongEma?: MaybeTrailStopAlongEma;
  private readonly now: () => number;
  private readonly recoverCache: (symbol: string) => void;

  // Keyed by `${model}:${symbol}` so two strategies can evaluate the same
  // symbol concurrently without blocking each other.
  private readonly inFlight = new Set<string>();

  constructor(options: StrategyEvaluatorOptions) {
    this.strategies = options.strategies;
    this.placeBracketOrder = options.placeBracketOrder;
    this.recordTradeContext = options.recordTradeContext;
    this.reconcileEntryFill = options.reconcileEntryFill;
    this.checkOpenTrades = options.checkOpenTrades;
    this.maybeMoveStopToBreakEven = options.maybeMoveStopToBreakEven;
    this.marketHours = options.marketHours;
    this.metrics = options.metrics;
    this.placeLimitOrder = options.placeLimitOrder;
    this.checkSyntheticStops = options.checkSyntheticStops;
    this.maybeTrailSyntheticStop = options.maybeTrailSyntheticStop;
    this.maybeRepegSyntheticExit = options.maybeRepegSyntheticExit;
    this.maybeTrailStopAlongEma = options.maybeTrailStopAlongEma;
    this.now = options.now ?? (() => Date.now());
    this.recoverCache = options.recoverCache;
  }

  clear(): void {
    this.inFlight.clear();
  }

  // Runs strategies in parallel: each one independently checks its own
  // watchlist membership and exposure, then evaluates and (optionally) places.
  // Strategies share no mutable state — TradeContext is keyed by (model,
  // symbol) and inFlight is keyed by `${name}:${symbol}`. Latency for the
  // last strategy drops from sum-of-strategies to max-of-strategies.
  async processSymbol(symbol: string, bar: Bar): Promise<void> {
    const session = this.marketHours.session(new Date(this.now()));
    // Solo operamos en sesiones tradeables. 'transition' (9:20-9:30) y
    // 'closed' caen acá: bars se siguen acumulando en barRepo pero el
    // manager no corre estrategias ni stops sintéticos.
    if (session !== 'pre' && session !== 'rth') return;

    // Trail por EMA: corre en pre + rth (a diferencia de los otros usecases de
    // trade que son pre-only). En pre debe ir antes del cross-check sintetico
    // para que use el stop ya actualizado; en rth no hay cross-check (los stops
    // son reales en el broker), pero el use case mueve el StopMarket via
    // replaceStopPrice. Filtra internamente por ctx con emaTrailPeriod.
    if (this.maybeTrailStopAlongEma) {
      try {
        await this.maybeTrailStopAlongEma.execute(symbol, bar);
      } catch (err) {
        log.warn(
          { symbol, err: errMsg(err) },
          'maybeTrailStopAlongEma threw — continuing',
        );
      }
    }

    // En pre corren: (1) trailing sintético, que sube el stopPrice de ctx
    // con trailingStopPercent siguiendo el high-watermark; (2) cross-check de
    // stops/TPs sintéticos. Trailing primero para que el cross use el stop
    // ya actualizado en el mismo bar. Ambos operan sobre el ctx persistido y
    // son indistinguibles para la estrategia, por eso corren una sola vez
    // por symbol-bar (no por estrategia).
    if (session === 'pre') {
      if (this.maybeTrailSyntheticStop) {
        try {
          await this.maybeTrailSyntheticStop.execute(symbol, bar);
        } catch (err) {
          log.warn(
            { symbol, err: errMsg(err) },
            'maybeTrailSyntheticStop threw — continuing',
          );
        }
      }
      if (this.checkSyntheticStops) {
        try {
          await this.checkSyntheticStops.execute(symbol, bar);
        } catch (err) {
          log.warn(
            { symbol, err: errMsg(err) },
            'checkSyntheticStops threw — continuing with strategies',
          );
        }
      }
      // Persigue el Limit de los exits ya disparados (forcedExitOrderId), re-pegando
      // al precio actual. Va despues de checkSyntheticStops: un exit recien armado
      // en este bar ya tiene su Limit fresco y no necesita repeg hasta el siguiente.
      if (this.maybeRepegSyntheticExit) {
        try {
          await this.maybeRepegSyntheticExit.execute(symbol, bar);
        } catch (err) {
          log.warn(
            { symbol, err: errMsg(err) },
            'maybeRepegSyntheticExit threw — continuing',
          );
        }
      }
    }

    await Promise.all(
      this.strategies.map(async (strategy) => {
        const watched = await strategy.watchlist.getBySymbol(symbol);
        if (!watched) return;
        await this.processStrategy(strategy, symbol, bar, session);
      }),
    );
  }

  private async processStrategy(
    strategy: DecisionStrategy,
    symbol: string,
    bar: Bar,
    session: 'pre' | 'rth',
  ): Promise<void> {
    const inFlightKey = `${strategy.name}:${symbol}`;
    if (this.inFlight.has(inFlightKey)) {
      log.debug({ model: strategy.name, symbol }, 'in-flight skip');
      return;
    }
    this.inFlight.add(inFlightKey);

    const evalStart = new Date(this.now()).toISOString();
    try {
      const { stillExposed } = await this.checkOpenTrades.execute({
        model: strategy.name,
        symbol,
      });
      if (stillExposed) {
        // Break-even trailing solo aplica en RTH (en pre no hay StopMarket
        // que mover; el flatten 9:20 cierra antes del open).
        if (
          session === 'rth' &&
          this.maybeMoveStopToBreakEven &&
          strategy.trailToBreakEvenAtProfit !== undefined
        ) {
          await this.maybeMoveStopToBreakEven.execute({
            model: strategy.name,
            symbol,
            lastPrice: bar.close,
            threshold: strategy.trailToBreakEvenAtProfit,
          });
        }
        return;
      }

      const accountId = strategy.accountId;
      const snapshot = await strategy.model.buildSnapshot({
        symbol,
        accountId,
        triggerBar: bar,
      });
      log.info(
        { model: strategy.name, session, snapshot },
        'evaluating snapshot',
      );
      const signal = strategy.model.evaluate(snapshot);
      const evalEnd = new Date(this.now()).toISOString();

      this.metrics.recordDecision(symbol, signal.action);
      if (signal.action !== 'buy') return;

      if (session === 'rth') {
        await this.placeRthBracket(strategy, signal, evalStart, evalEnd);
      } else {
        await this.placePreLimit(strategy, signal, evalStart, evalEnd);
      }
    } catch (err) {
      log.error(
        { model: strategy.name, symbol, err: errMsg(err) },
        'process failed',
      );
      if (err instanceof CacheUnderfilledError) {
        this.recoverCache(symbol);
      }
    } finally {
      this.inFlight.delete(inFlightKey);
    }
  }

  private async placeRthBracket(
    strategy: DecisionStrategy,
    signal: BuySignal,
    evalStart: string,
    evalEnd: string,
  ): Promise<void> {
    const accountId = strategy.accountId;
    const result = await this.placeBracketOrder.execute({
      symbol: signal.symbol,
      side: signal.side,
      entryLimitPrice: signal.entryLimitPrice,
      quantity: signal.quantity,
      stopOffset: signal.stopOffset,
      takeProfitOffset: signal.takeProfitOffset,
      accountId,
    });
    this.metrics.recordOrderResult(result.status);
    log.info(
      {
        model: strategy.name,
        symbol: signal.symbol,
        entryOrderId: result.entryOrderId,
        stopOrderId: result.stopOrderId,
        takeProfitOrderId: result.takeProfitOrderId,
        status: result.status,
      },
      'bracket placed',
    );

    if (
      !result.entryOrderId ||
      result.status === 'rejected' ||
      result.status === 'cancelled' ||
      result.status === 'expired'
    ) {
      return;
    }
    let ctx;
    try {
      ctx = await this.recordTradeContext.execute({
        session: 'rth',
        model: strategy.name,
        accountId,
        bracket: {
          entryOrderId: result.entryOrderId,
          stopOrderId: result.stopOrderId,
          takeProfitOrderId: result.takeProfitOrderId,
        },
        signal,
        evalStart,
        evalEnd,
      });
    } catch (err) {
      log.warn(
        {
          model: strategy.name,
          symbol: signal.symbol,
          entryOrderId: result.entryOrderId,
          err: errMsg(err),
        },
        'failed to persist trade context',
      );
      return;
    }
    await this.reconcileEntryFill.execute({ ctx });
  }

  private async placePreLimit(
    strategy: DecisionStrategy,
    signal: BuySignal,
    evalStart: string,
    evalEnd: string,
  ): Promise<void> {
    if (!this.placeLimitOrder) {
      log.warn(
        { model: strategy.name, symbol: signal.symbol },
        'pre signal ignored — placeLimitOrder not wired',
      );
      return;
    }
    const accountId = strategy.accountId;
    const result = await this.placeLimitOrder.execute({
      symbol: signal.symbol,
      side: signal.side,
      limitPrice: signal.entryLimitPrice,
      quantity: signal.quantity,
      accountId,
      duration: 'DYP',
      route: 'ARCA',
    });
    log.info(
      {
        model: strategy.name,
        symbol: signal.symbol,
        entryOrderId: result.orderId,
        status: result.status,
      },
      'pre limit entry placed',
    );

    if (
      !result.orderId ||
      result.status === 'rejected' ||
      result.status === 'cancelled' ||
      result.status === 'expired'
    ) {
      return;
    }
    let ctx;
    try {
      ctx = await this.recordTradeContext.execute({
        session: 'pre',
        model: strategy.name,
        accountId,
        entryOrderId: result.orderId,
        signal,
        evalStart,
        evalEnd,
      });
    } catch (err) {
      log.warn(
        {
          model: strategy.name,
          symbol: signal.symbol,
          entryOrderId: result.orderId,
          err: errMsg(err),
        },
        'failed to persist pre trade context',
      );
      return;
    }
    await this.reconcileEntryFill.execute({ ctx });
  }
}
