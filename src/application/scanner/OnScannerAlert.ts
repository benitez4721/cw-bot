import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { EventStrategy } from '../../domain/decision/EventStrategy.js';
import type { IndicatorPort } from '../../domain/indicators/IndicatorPort.js';
import type { MarketHours } from '../../domain/market/MarketHours.js';
import type { BarRepository } from '../../domain/marketdata/BarRepository.js';
import type { HistoricalBarsPort } from '../../domain/marketdata/HistoricalBarsPort.js';
import type { MetricsPort } from '../../domain/metrics/MetricsPort.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../domain/trade/TradeTypes.js';
import { logger } from '../../infrastructure/logging/logger.js';
import type { PlaceBracketOrder } from '../broker/PlaceBracketOrder.js';
import type { PlaceLimitOrder } from '../broker/PlaceLimitOrder.js';
import type { PlaceTrailingBracketOrder } from '../broker/PlaceTrailingBracketOrder.js';
import type { CheckOpenTrades } from '../trade/CheckOpenTrades.js';
import type { ReconcileEntryFill } from '../trade/ReconcileEntryFill.js';

const log = logger.child({ component: 'OnScannerAlert' });

// Cantidad de barras a traer en el bootstrap on-demand cuando el repo local
// no tiene suficiente historia para calcular la EMA en el momento del alert.
// EMA(18) sobre M1 requiere >=18 barras; pedimos un colchon para que el adapter
// devuelva varios warm-up samples.
const EMA_BOOTSTRAP_BARS = 60;

export interface OnScannerAlertDeps {
  strategy: EventStrategy;
  broker: BrokerPort;
  // Branch 'percent': trail nativo de TradeStation en RTH (server-side).
  placeTrailingBracketOrder: PlaceTrailingBracketOrder;
  // Branch 'ema': bracket clasico con StopMarket fijo en RTH; el bot mueve el
  // stop cada barra M1 via MaybeTrailStopAlongEma.
  placeBracketOrder: PlaceBracketOrder;
  // Usado en sesion pre (ambos branches). El broker no soporta trailing ni
  // OSO en pre, asi que mandamos un Limit DYP+ARCA y gestionamos el stop
  // sinteticamente via MaybeTrail* + CheckSyntheticStops.
  placeLimitOrder: PlaceLimitOrder;
  tradeRepo: TradeContextRepository;
  checkOpenTrades: CheckOpenTrades;
  reconcileEntryFill: ReconcileEntryFill;
  marketHours: MarketHours;
  metrics: MetricsPort;
  // Deps opcionales para la rama 'ema'. Las strategies 'percent' no las
  // requieren; quedan undefined en ese caso.
  indicators?: IndicatorPort;
  barRepo?: BarRepository;
  historicalBars?: HistoricalBarsPort;
  now?: () => string;
}

export class OnScannerAlert {
  private readonly strategy: EventStrategy;
  private readonly broker: BrokerPort;
  private readonly placeTrailingBracketOrder: PlaceTrailingBracketOrder;
  private readonly placeBracketOrder: PlaceBracketOrder;
  private readonly placeLimitOrder: PlaceLimitOrder;
  private readonly tradeRepo: TradeContextRepository;
  private readonly checkOpenTrades: CheckOpenTrades;
  private readonly reconcileEntryFill: ReconcileEntryFill;
  private readonly marketHours: MarketHours;
  private readonly metrics: MetricsPort;
  private readonly indicators?: IndicatorPort;
  private readonly barRepo?: BarRepository;
  private readonly historicalBars?: HistoricalBarsPort;
  private readonly now: () => string;

  constructor(deps: OnScannerAlertDeps) {
    this.strategy = deps.strategy;
    this.broker = deps.broker;
    this.placeTrailingBracketOrder = deps.placeTrailingBracketOrder;
    this.placeBracketOrder = deps.placeBracketOrder;
    this.placeLimitOrder = deps.placeLimitOrder;
    this.tradeRepo = deps.tradeRepo;
    this.checkOpenTrades = deps.checkOpenTrades;
    this.reconcileEntryFill = deps.reconcileEntryFill;
    this.marketHours = deps.marketHours;
    this.metrics = deps.metrics;
    this.indicators = deps.indicators;
    this.barRepo = deps.barRepo;
    this.historicalBars = deps.historicalBars;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async handle(symbol: string): Promise<void> {
    const session = this.marketHours.session(new Date(this.now()));
    // Solo abrimos en pre y rth. transition (9:20-9:30) es la ventana de
    // flatten — no tiene sentido entrar para que FlattenPrePositions cierre
    // acto seguido. closed cae al mismo bucket.
    if (session !== 'pre' && session !== 'rth') {
      this.metrics.recordAlertOutcome(this.strategy.name, 'skipped_closed');
      log.info(
        { model: this.strategy.name, symbol, session },
        'alert skipped — market not tradeable',
      );
      return;
    }

    const { stillExposed } = await this.checkOpenTrades.execute({
      model: this.strategy.name,
      symbol,
    });
    if (stillExposed) {
      this.metrics.recordAlertOutcome(this.strategy.name, 'skipped_busy');
      log.info(
        { model: this.strategy.name, symbol },
        'alert skipped — symbol already has an active trade',
      );
      return;
    }

    const accountId = this.strategy.accountId;
    const quote = await this.broker.getQuote({ symbol, accountId });
    const reference = quote.ask;
    if (
      reference === undefined ||
      !Number.isFinite(reference) ||
      reference <= 0
    ) {
      this.metrics.recordAlertOutcome(this.strategy.name, 'rejected');
      log.warn(
        { model: this.strategy.name, symbol, quote },
        'alert dropped — quote has no usable ask',
      );
      return;
    }
    const entryLimitPrice =
      reference * (1 + this.strategy.entryBufferBps / 10_000);

    const evalStart = this.now();
    if (this.strategy.trailMode === 'percent') {
      if (session === 'rth') {
        await this.openRthPercent(symbol, entryLimitPrice, evalStart);
      } else {
        await this.openPrePercent(symbol, entryLimitPrice, evalStart);
      }
    } else {
      if (session === 'rth') {
        await this.openRthEma(symbol, entryLimitPrice, evalStart);
      } else {
        await this.openPreEma(symbol, entryLimitPrice, evalStart);
      }
    }
  }

  private async openRthPercent(
    symbol: string,
    entryLimitPrice: number,
    evalStart: string,
  ): Promise<void> {
    if (this.strategy.trailMode !== 'percent') {
      throw new Error(
        `openRthPercent invoked with trailMode=${this.strategy.trailMode}`,
      );
    }
    const accountId = this.strategy.accountId;
    const result = await this.placeTrailingBracketOrder.execute({
      symbol,
      side: 'BUY',
      quantity: this.strategy.quantity,
      entryLimitPrice,
      trailingStopPercent: this.strategy.trailingStopPercent,
      accountId,
    });
    const evalEnd = this.now();

    if (result.status === 'rejected') {
      this.metrics.recordAlertOutcome(this.strategy.name, 'rejected');
      log.warn(
        {
          model: this.strategy.name,
          symbol,
          entryLimitPrice,
          error: result.error,
          message: result.message,
        },
        'trailing bracket rejected by broker',
      );
      return;
    }

    const ctx: TradeContext = {
      model: this.strategy.name,
      accountId,
      symbol,
      side: 'BUY',
      entryLimitPrice,
      evalStart,
      evalEnd,
      bracket: {
        entryOrderId: result.entryOrderId,
        stopOrderId: result.stopOrderId,
      },
      indicators: null,
      checks: [],
      status: 'active',
      session: 'rth',
    };
    await this.tradeRepo.put(ctx);
    this.metrics.recordAlertOutcome(this.strategy.name, 'opened');
    log.info(
      {
        model: this.strategy.name,
        symbol,
        entryLimitPrice,
        entryOrderId: result.entryOrderId,
        stopOrderId: result.stopOrderId,
      },
      'trade opened from scanner alert (rth, percent trail)',
    );
    await this.reconcileEntryFill.execute({ ctx });
  }

  private async openPrePercent(
    symbol: string,
    entryLimitPrice: number,
    evalStart: string,
  ): Promise<void> {
    if (this.strategy.trailMode !== 'percent') {
      throw new Error(
        `openPrePercent invoked with trailMode=${this.strategy.trailMode}`,
      );
    }
    const accountId = this.strategy.accountId;
    const result = await this.placeLimitOrder.execute({
      symbol,
      side: 'BUY',
      quantity: this.strategy.quantity,
      limitPrice: entryLimitPrice,
      accountId,
      duration: 'DYP',
      route: 'ARCA',
    });
    const evalEnd = this.now();

    if (
      !result.orderId ||
      result.status === 'rejected' ||
      result.status === 'cancelled' ||
      result.status === 'expired'
    ) {
      this.metrics.recordAlertOutcome(this.strategy.name, 'rejected');
      log.warn(
        {
          model: this.strategy.name,
          symbol,
          entryLimitPrice,
          status: result.status,
          error: result.error,
          message: result.message,
        },
        'pre limit entry rejected by broker',
      );
      return;
    }

    // Stop inicial sintetico derivado del entryLimitPrice (proxy del fill,
    // mismo criterio que TradeStationBrokerAdapter.placeBracketOrder).
    // MaybeTrailSyntheticStop lo subira bar-a-bar siguiendo el high-watermark
    // una vez que llegue el fill del OrderStream (entryFillPrice).
    const stopPrice = round2(
      entryLimitPrice * (1 - this.strategy.trailingStopPercent / 100),
    );
    const ctx: TradeContext = {
      model: this.strategy.name,
      accountId,
      symbol,
      side: 'BUY',
      entryLimitPrice,
      stopPrice,
      trailingStopPercent: this.strategy.trailingStopPercent,
      evalStart,
      evalEnd,
      bracket: { entryOrderId: result.orderId },
      indicators: null,
      checks: [],
      status: 'active',
      session: 'pre',
      syntheticExitFired: false,
    };
    await this.tradeRepo.put(ctx);
    this.metrics.recordAlertOutcome(this.strategy.name, 'opened');
    log.info(
      {
        model: this.strategy.name,
        symbol,
        entryLimitPrice,
        stopPrice,
        trailingStopPercent: this.strategy.trailingStopPercent,
        entryOrderId: result.orderId,
      },
      'trade opened from scanner alert (pre, percent trail)',
    );
    await this.reconcileEntryFill.execute({ ctx });
  }

  private async openRthEma(
    symbol: string,
    entryLimitPrice: number,
    evalStart: string,
  ): Promise<void> {
    if (this.strategy.trailMode !== 'ema') {
      throw new Error(
        `openRthEma invoked with trailMode=${this.strategy.trailMode}`,
      );
    }
    const stopPrice = await this.computeEmaStop(symbol, entryLimitPrice);
    if (stopPrice === undefined) return;

    const accountId = this.strategy.accountId;
    const stopOffset = round2(entryLimitPrice - stopPrice);
    if (stopOffset <= 0) {
      this.metrics.recordAlertOutcome(this.strategy.name, 'rejected');
      log.warn(
        {
          model: this.strategy.name,
          symbol,
          entryLimitPrice,
          stopPrice,
          stopOffset,
        },
        'alert dropped — EMA stop above entry; refusing to open trade',
      );
      return;
    }
    const result = await this.placeBracketOrder.execute({
      symbol,
      side: 'BUY',
      quantity: this.strategy.quantity,
      entryLimitPrice,
      stopOffset,
      accountId,
    });
    const evalEnd = this.now();

    if (result.status === 'rejected') {
      this.metrics.recordAlertOutcome(this.strategy.name, 'rejected');
      log.warn(
        {
          model: this.strategy.name,
          symbol,
          entryLimitPrice,
          stopPrice,
          error: result.error,
          message: result.message,
        },
        'bracket (ema trail) rejected by broker',
      );
      return;
    }

    const ctx: TradeContext = {
      model: this.strategy.name,
      accountId,
      symbol,
      side: 'BUY',
      entryLimitPrice,
      stopPrice,
      emaTrailPeriod: this.strategy.emaTrailPeriod,
      emaTrailBufferBps: this.strategy.emaTrailBufferBps,
      evalStart,
      evalEnd,
      bracket: {
        entryOrderId: result.entryOrderId,
        stopOrderId: result.stopOrderId,
      },
      indicators: null,
      checks: [],
      status: 'active',
      session: 'rth',
    };
    await this.tradeRepo.put(ctx);
    this.metrics.recordAlertOutcome(this.strategy.name, 'opened');
    log.info(
      {
        model: this.strategy.name,
        symbol,
        entryLimitPrice,
        stopPrice,
        emaTrailPeriod: this.strategy.emaTrailPeriod,
        emaTrailBufferBps: this.strategy.emaTrailBufferBps,
        entryOrderId: result.entryOrderId,
        stopOrderId: result.stopOrderId,
      },
      'trade opened from scanner alert (rth, ema trail)',
    );
    await this.reconcileEntryFill.execute({ ctx });
  }

  private async openPreEma(
    symbol: string,
    entryLimitPrice: number,
    evalStart: string,
  ): Promise<void> {
    if (this.strategy.trailMode !== 'ema') {
      throw new Error(
        `openPreEma invoked with trailMode=${this.strategy.trailMode}`,
      );
    }
    const stopPrice = await this.computeEmaStop(symbol, entryLimitPrice);
    if (stopPrice === undefined) return;

    const accountId = this.strategy.accountId;
    const result = await this.placeLimitOrder.execute({
      symbol,
      side: 'BUY',
      quantity: this.strategy.quantity,
      limitPrice: entryLimitPrice,
      accountId,
      duration: 'DYP',
      route: 'ARCA',
    });
    const evalEnd = this.now();

    if (
      !result.orderId ||
      result.status === 'rejected' ||
      result.status === 'cancelled' ||
      result.status === 'expired'
    ) {
      this.metrics.recordAlertOutcome(this.strategy.name, 'rejected');
      log.warn(
        {
          model: this.strategy.name,
          symbol,
          entryLimitPrice,
          status: result.status,
          error: result.error,
          message: result.message,
        },
        'pre limit entry rejected by broker',
      );
      return;
    }

    const ctx: TradeContext = {
      model: this.strategy.name,
      accountId,
      symbol,
      side: 'BUY',
      entryLimitPrice,
      stopPrice,
      emaTrailPeriod: this.strategy.emaTrailPeriod,
      emaTrailBufferBps: this.strategy.emaTrailBufferBps,
      evalStart,
      evalEnd,
      bracket: { entryOrderId: result.orderId },
      indicators: null,
      checks: [],
      status: 'active',
      session: 'pre',
      syntheticExitFired: false,
    };
    await this.tradeRepo.put(ctx);
    this.metrics.recordAlertOutcome(this.strategy.name, 'opened');
    log.info(
      {
        model: this.strategy.name,
        symbol,
        entryLimitPrice,
        stopPrice,
        emaTrailPeriod: this.strategy.emaTrailPeriod,
        emaTrailBufferBps: this.strategy.emaTrailBufferBps,
        entryOrderId: result.orderId,
      },
      'trade opened from scanner alert (pre, ema trail)',
    );
    await this.reconcileEntryFill.execute({ ctx });
  }

  // Calcula `EMA(period) * (1 ± bufferBps/10_000)` para el stop inicial.
  // Bootstrap on-demand: si el barRepo no tiene `period` barras M1 cached
  // para el simbolo del alert (caso comun cuando el simbolo no pertenece a
  // la watchlist de ninguna DecisionStrategy), refresca el cache via el
  // HistoricalBarsPort. Si tras el bootstrap sigue sin haber suficientes
  // barras, marca outcome 'rejected' y retorna undefined.
  private async computeEmaStop(
    symbol: string,
    entryLimitPrice: number,
  ): Promise<number | undefined> {
    if (this.strategy.trailMode !== 'ema') return undefined;
    if (!this.indicators) {
      this.metrics.recordAlertOutcome(this.strategy.name, 'rejected');
      log.error(
        { model: this.strategy.name, symbol },
        'ema trail requires IndicatorPort dep — strategy misconfigured',
      );
      return undefined;
    }
    const period = this.strategy.emaTrailPeriod;
    const bufferBps = this.strategy.emaTrailBufferBps;

    try {
      await this.ensureBarsForEma(symbol, period);
      const ema = await this.indicators.getEMA({
        symbol,
        interval: '1min',
        period,
      });
      const stop = round2(ema.value * (1 - bufferBps / 10_000));
      if (!Number.isFinite(stop) || stop <= 0 || stop >= entryLimitPrice) {
        this.metrics.recordAlertOutcome(this.strategy.name, 'rejected');
        log.warn(
          {
            model: this.strategy.name,
            symbol,
            entryLimitPrice,
            ema: ema.value,
            stop,
          },
          'alert dropped — EMA-derived stop not below entry',
        );
        return undefined;
      }
      return stop;
    } catch (err) {
      this.metrics.recordAlertOutcome(this.strategy.name, 'rejected');
      log.warn(
        {
          model: this.strategy.name,
          symbol,
          err: err instanceof Error ? err.message : String(err),
        },
        'failed to compute EMA-derived stop — alert dropped',
      );
      return undefined;
    }
  }

  // Si el repo local no tiene >= period barras M1 para el simbolo, hace un
  // fetch via HistoricalBarsPort y persiste en el repo. No-op si las
  // dependencias opcionales no estan inyectadas (en ese caso, getEMA va a
  // lanzar y el caller marca rejected).
  private async ensureBarsForEma(
    symbol: string,
    period: number,
  ): Promise<void> {
    if (!this.barRepo || !this.historicalBars) return;
    const cached = await this.barRepo.get(symbol, '1min');
    if (cached.length >= period) return;
    log.info(
      { model: this.strategy.name, symbol, cached: cached.length, period },
      'bootstrapping bars for EMA on alert',
    );
    const bars = await this.historicalBars.fetchHistoricalBars({
      symbol,
      interval: '1min',
      limit: EMA_BOOTSTRAP_BARS,
    });
    await this.barRepo.set(symbol, '1min', bars);
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
