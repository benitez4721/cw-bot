import type { DecisionStrategy } from '../../domain/decision/DecisionStrategy.js';
import type { MarketHours, Session } from '../../domain/market/MarketHours.js';
import type { BarRepository } from '../../domain/marketdata/BarRepository.js';
import type { HistoricalBarsPort } from '../../domain/marketdata/HistoricalBarsPort.js';
import type { Bar } from '../../domain/marketdata/MarketDataTypes.js';
import type { MarketFeedPort } from '../../domain/marketdata/MarketFeedPort.js';
import type { MetricsPort } from '../../domain/metrics/MetricsPort.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import { CacheUnderfilledError } from '../../domain/indicators/IndicatorErrors.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { errMsg } from '../../shared/errors.js';
import type { FlattenAllPositions } from '../broker/FlattenAllPositions.js';
import type { FlattenPrePositions } from '../broker/FlattenPrePositions.js';
import type { PlaceBracketOrder } from '../broker/PlaceBracketOrder.js';
import type { PlaceLimitOrder } from '../broker/PlaceLimitOrder.js';
import type { CheckOpenTrades } from '../trade/CheckOpenTrades.js';
import type { CheckSyntheticStops } from '../trade/CheckSyntheticStops.js';
import type { MaybeMoveStopToBreakEven } from '../trade/MaybeMoveStopToBreakEven.js';
import type { MaybeTrailStopAlongEma } from '../trade/MaybeTrailStopAlongEma.js';
import type { MaybeTrailSyntheticStop } from '../trade/MaybeTrailSyntheticStop.js';
import type { ReconcileEntryFill } from '../trade/ReconcileEntryFill.js';
import type { RecordTradeContext } from '../trade/RecordTradeContext.js';
import { SessionBoundaryRunner } from './SessionBoundaryRunner.js';
import { SymbolSubscriptionService } from './SymbolSubscriptionService.js';

const log = logger.child({ component: 'BarStreamManager' });

const DEFAULT_SYNC_INTERVAL_MS = 10_000;

export type BarStreamManagerStatus = 'idle' | 'running';

export interface BarStreamManagerOptions {
  feed: MarketFeedPort;
  historicalBars: HistoricalBarsPort;
  barRepo: BarRepository;
  strategies: DecisionStrategy[];
  placeBracketOrder: PlaceBracketOrder;
  recordTradeContext: RecordTradeContext;
  reconcileEntryFill: ReconcileEntryFill;
  checkOpenTrades: CheckOpenTrades;
  maybeMoveStopToBreakEven?: MaybeMoveStopToBreakEven;
  marketHours: MarketHours;
  metrics: MetricsPort;
  // Disparado una sola vez al detectarse la transición rth → closed
  // (15:50 ET con UsMarketHoursAdapter). Opcional para tests legacy.
  flattenAll?: FlattenAllPositions;
  // Disparado una sola vez al detectarse la transición pre → transition
  // (9:20 ET con UsMarketHoursAdapter). Cierra las posiciones pre con Limit
  // cross-the-spread antes de que arranque RTH. Opcional para tests legacy.
  flattenPrePositions?: FlattenPrePositions;
  // Usado en el branch pre de processStrategy. Opcional para tests legacy y
  // entornos solo-RTH (DECISION_ENABLED apagado en pre).
  placeLimitOrder?: PlaceLimitOrder;
  checkSyntheticStops?: CheckSyntheticStops;
  // Trailing stop sintetico para ctx pre con trailingStopPercent. Invocado
  // antes de checkSyntheticStops para que el cross-check use el stop ya
  // actualizado.
  maybeTrailSyntheticStop?: MaybeTrailSyntheticStop;
  // Trail por EMA para ctx con emaTrailPeriod/emaTrailBufferBps (EventStrategy
  // HighOfDayAlertEmaTrail). Corre en pre + rth, antes de checkSyntheticStops
  // en pre. En rth ademas mueve el StopMarket del broker via replaceStopPrice.
  maybeTrailStopAlongEma?: MaybeTrailStopAlongEma;
  // Trade repo: ademas de las watchlists de las DecisionStrategy, los simbolos
  // de los trades activos (EventStrategy incluidos) se suman al set suscrito
  // para que el manager reciba sus barras. Sin esto, los trades de event no
  // tendrian feed a menos que coincidieran con la watchlist de algun modelo.
  tradeRepo?: TradeContextRepository;
  // Disparado una sola vez por día NY cuando el tick cae dentro de la
  // ventana 9:29 ET de un día hábil. Bot arranca el día con Redis limpio.
  flushRedis?: () => Promise<void>;
  bootstrapBars?: number;
  syncIntervalMs?: number;
  // Injected for tests
  now?: () => number;
  schedule?: (cb: () => void, ms: number) => NodeJS.Timeout;
  cancel?: (handle: NodeJS.Timeout) => void;
}

// Event-driven runtime: subscribes to the realtime feed, keeps the bar cache
// fresh, and triggers each strategy's evaluation on every AM bar close.
// Symbols are added/removed by polling the union of strategy watchlists on a
// fixed interval. Each strategy carries its own watchlist and order config;
// exposure is tracked per (model, symbol) via the trade context repo.
export class BarStreamManager {
  private readonly feed: MarketFeedPort;
  private readonly strategies: DecisionStrategy[];
  private readonly placeBracketOrder: PlaceBracketOrder;
  private readonly recordTradeContext: RecordTradeContext;
  private readonly reconcileEntryFill: ReconcileEntryFill;
  private readonly checkOpenTrades: CheckOpenTrades;
  private readonly maybeMoveStopToBreakEven?: MaybeMoveStopToBreakEven;
  private readonly marketHours: MarketHours;
  private readonly metrics: MetricsPort;
  private readonly sessionBoundaries: SessionBoundaryRunner;
  private readonly subscriptions: SymbolSubscriptionService;
  private readonly placeLimitOrder?: PlaceLimitOrder;
  private readonly checkSyntheticStops?: CheckSyntheticStops;
  private readonly maybeTrailSyntheticStop?: MaybeTrailSyntheticStop;
  private readonly maybeTrailStopAlongEma?: MaybeTrailStopAlongEma;
  // Sesion vista en el tick anterior. Sirve para detectar boundaries
  // (pre→transition, rth→closed) sin depender del estado del feed.
  private lastSession: Session | null = null;
  private readonly syncIntervalMs: number;
  private readonly now: () => number;
  private readonly schedule: (cb: () => void, ms: number) => NodeJS.Timeout;
  private readonly cancel: (handle: NodeJS.Timeout) => void;

  // Keyed by `${model}:${symbol}` so two strategies can evaluate the same
  // symbol concurrently without blocking each other.
  private readonly inFlight = new Set<string>();
  private tickTimer: NodeJS.Timeout | null = null;
  private status: BarStreamManagerStatus = 'idle';
  private handlersRegistered = false;
  private lastSuccessfulTick = 0;
  private feedConnected = false;

  constructor(options: BarStreamManagerOptions) {
    this.feed = options.feed;
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
    this.maybeTrailStopAlongEma = options.maybeTrailStopAlongEma;
    this.syncIntervalMs = options.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? ((cb, ms) => setTimeout(cb, ms));
    this.cancel = options.cancel ?? ((h) => clearTimeout(h));
    this.sessionBoundaries = new SessionBoundaryRunner({
      flattenAll: options.flattenAll,
      flattenPrePositions: options.flattenPrePositions,
      flushRedis: options.flushRedis,
    });
    this.subscriptions = new SymbolSubscriptionService({
      feed: options.feed,
      historicalBars: options.historicalBars,
      barRepo: options.barRepo,
      strategies: options.strategies,
      metrics: options.metrics,
      tradeRepo: options.tradeRepo,
      bootstrapBars: options.bootstrapBars,
      now: this.now,
    });
  }

  getStatus(): BarStreamManagerStatus {
    return this.status;
  }

  lastSuccessfulTickAt(): number {
    return this.lastSuccessfulTick;
  }

  subscribedCount(): number {
    return this.subscriptions.subscribedCount();
  }

  async forceSync(): Promise<void> {
    return this.tick();
  }

  async start(): Promise<void> {
    if (this.status === 'running') return;

    if (!this.handlersRegistered) {
      this.feed.onBar((symbol, bar) => {
        void this.handleBar(symbol, bar).catch((err) => {
          log.error(
            { symbol, err: errMsg(err) },
            'handleBar failed unexpectedly',
          );
        });
      });
      this.feed.onConnectionChange((connected) => {
        log.info({ connected }, 'feed connection');
        this.metrics.setMarketFeedConnected(connected);
      });
      this.handlersRegistered = true;
    }

    this.status = 'running';
    await this.tick();
    this.scheduleNextTick();
    log.info(
      {
        subscribed: this.subscriptions.subscribedCount(),
        marketOpen: this.feedConnected,
        strategies: this.strategies.map((s) => s.name),
      },
      'started',
    );
  }

  stop(): void {
    if (this.status === 'idle') return;
    this.status = 'idle';
    if (this.tickTimer) {
      this.cancel(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.feedConnected) {
      this.feed.disconnect();
      this.feedConnected = false;
    }
    this.subscriptions.clear();
    this.inFlight.clear();
  }

  private scheduleNextTick(): void {
    if (this.status !== 'running') return;
    this.tickTimer = this.schedule(() => {
      this.tickTimer = null;
      void this.tick()
        .catch((err) => {
          log.error({ err: errMsg(err) }, 'tick failed');
        })
        .finally(() => this.scheduleNextTick());
    }, this.syncIntervalMs);
  }

  private async tick(): Promise<void> {
    const nowDate = new Date(this.now());
    await this.sessionBoundaries.triggerPreMarketFlush(nowDate);
    const session = this.marketHours.session(nowDate);
    const connected = this.marketHours.isConnected(nowDate);

    // Boundary pre → transition (9:20 ET): flatten posiciones pre antes de
    // RTH. Lo evaluamos antes de tocar feed/sync para que el flatten arranque
    // aunque haya un connect fail en este mismo tick.
    if (this.lastSession === 'pre' && session === 'transition') {
      this.sessionBoundaries.triggerPreFlatten(nowDate);
    }

    this.lastSession = session;

    if (connected && !this.feedConnected) {
      log.info({ session }, 'market connected — connecting feed');
      try {
        await this.feed.connect();
        this.feedConnected = true;
      } catch (err) {
        log.error(
          { err: errMsg(err) },
          'feed connect failed — will retry on next tick',
        );
        return;
      }
      await this.subscriptions.syncWatchlist();
      return;
    }

    if (!connected && this.feedConnected) {
      log.info('market closed — disconnecting feed');
      this.feed.disconnect();
      this.feedConnected = false;
      this.subscriptions.clear();
      this.inFlight.clear();
      this.sessionBoundaries.triggerRthFlatten(nowDate);
      return;
    }

    if (connected && this.feedConnected) {
      await this.subscriptions.syncWatchlist();
    }
  }

  private async handleBar(symbol: string, bar: Bar): Promise<void> {
    const shouldEvaluate = await this.subscriptions.ingestBar(symbol, bar);
    if (!shouldEvaluate) return;
    await this.processSymbol(symbol, bar);
    this.lastSuccessfulTick = this.now();
  }

  // Runs strategies in parallel: each one independently checks its own
  // watchlist membership and exposure, then evaluates and (optionally) places.
  // Strategies share no mutable state — TradeContext is keyed by (model,
  // symbol) and inFlight is keyed by `${name}:${symbol}`. Latency for the
  // last strategy drops from sum-of-strategies to max-of-strategies.
  private async processSymbol(symbol: string, bar: Bar): Promise<void> {
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
        void this.subscriptions.recoverCache(symbol);
      }
    } finally {
      this.inFlight.delete(inFlightKey);
    }
  }

  private async placeRthBracket(
    strategy: DecisionStrategy,
    signal: Extract<
      ReturnType<DecisionStrategy['model']['evaluate']>,
      { action: 'buy' }
    >,
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
    signal: Extract<
      ReturnType<DecisionStrategy['model']['evaluate']>,
      { action: 'buy' }
    >,
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
