import type { EventStrategy } from '../../domain/decision/EventStrategy.js';
import type { IndicatorPort } from '../../domain/indicators/IndicatorPort.js';
import type { BarRepository } from '../../domain/marketdata/BarRepository.js';
import type { HistoricalBarsPort } from '../../domain/marketdata/HistoricalBarsPort.js';
import type { MetricsPort } from '../../domain/metrics/MetricsPort.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../domain/trade/TradeTypes.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { bpsToFraction, round2 } from '../../domain/shared/math.js';
import type { PlaceBracketOrder } from '../broker/PlaceBracketOrder.js';
import type { PlaceLimitOrder } from '../broker/PlaceLimitOrder.js';
import type { PlaceTrailingBracketOrder } from '../broker/PlaceTrailingBracketOrder.js';
import type { ReconcileEntryFill } from './ReconcileEntryFill.js';

const log = logger.child({ component: 'OpenEventTrade' });

// Cantidad de barras a traer en el bootstrap on-demand cuando el repo local
// no tiene suficiente historia para calcular la EMA en el momento del alert.
// EMA(18) sobre M1 requiere >=18 barras; pedimos un colchon para que el adapter
// devuelva varios warm-up samples.
const EMA_BOOTSTRAP_BARS = 60;

export interface OpenEventTradeDeps {
  strategy: EventStrategy;
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
  reconcileEntryFill: ReconcileEntryFill;
  metrics: MetricsPort;
  // Deps opcionales para la rama 'ema'. Las strategies 'percent' no las
  // requieren; quedan undefined en ese caso.
  indicators?: IndicatorPort;
  barRepo?: BarRepository;
  historicalBars?: HistoricalBarsPort;
  now?: () => string;
}

export interface OpenEventTradeInput {
  symbol: string;
  entryLimitPrice: number;
  evalStart: string;
  session: 'pre' | 'rth';
}

// Stop inicial resuelto antes de enviar la orden. `stopPrice` es el precio
// objetivo (proxy del fill); `stopOffset` la distancia al entry usada para el
// sizing por riesgo.
interface ResolvedStop {
  stopOffset: number;
  stopPrice: number;
}

// OrderIds normalizados tras una colocacion exitosa (rth bracket o pre Limit).
interface Placement {
  entryOrderId: string;
  stopOrderId?: string;
}

// Abre un trade para una EventStrategy a partir de un alert ya validado por
// OnScannerAlert (sesion tradeable, sin exposicion previa, quote usable).
// Pipeline parametrizado por (trailMode, session):
//   1. resolveStop    — stop inicial (percent: % del entry; ema: EMA-derived)
//   2. guardQuantity  — sizing por riesgo en $; rechaza si redondea a 0
//   3. placeEntry     — rth: bracket (trailing/ema) | pre: Limit DYP+ARCA
//   4. buildContext   — TradeContext con los campos variantes del modo/sesion
//   5. persist + recordAlertOutcome('opened') + reconcileEntryFill
// Cada paso que rechaza ya emitio su metric+log y devuelve undefined.
export class OpenEventTrade {
  private readonly strategy: EventStrategy;
  private readonly placeTrailingBracketOrder: PlaceTrailingBracketOrder;
  private readonly placeBracketOrder: PlaceBracketOrder;
  private readonly placeLimitOrder: PlaceLimitOrder;
  private readonly tradeRepo: TradeContextRepository;
  private readonly reconcileEntryFill: ReconcileEntryFill;
  private readonly metrics: MetricsPort;
  private readonly indicators?: IndicatorPort;
  private readonly barRepo?: BarRepository;
  private readonly historicalBars?: HistoricalBarsPort;
  private readonly now: () => string;

  constructor(deps: OpenEventTradeDeps) {
    this.strategy = deps.strategy;
    this.placeTrailingBracketOrder = deps.placeTrailingBracketOrder;
    this.placeBracketOrder = deps.placeBracketOrder;
    this.placeLimitOrder = deps.placeLimitOrder;
    this.tradeRepo = deps.tradeRepo;
    this.reconcileEntryFill = deps.reconcileEntryFill;
    this.metrics = deps.metrics;
    this.indicators = deps.indicators;
    this.barRepo = deps.barRepo;
    this.historicalBars = deps.historicalBars;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async execute(input: OpenEventTradeInput): Promise<void> {
    const { symbol, entryLimitPrice, evalStart, session } = input;

    const stop = await this.resolveStop(symbol, entryLimitPrice);
    if (stop === undefined) return;

    const quantity = this.guardQuantity(
      symbol,
      entryLimitPrice,
      stop.stopOffset,
    );
    if (quantity === undefined) return;

    const placement = await this.placeEntry(
      session,
      symbol,
      entryLimitPrice,
      quantity,
      stop.stopOffset,
    );
    const evalEnd = this.now();
    if (placement === undefined) return;

    const ctx = this.buildContext({
      session,
      symbol,
      entryLimitPrice,
      evalStart,
      evalEnd,
      stopPrice: stop.stopPrice,
      placement,
    });
    await this.tradeRepo.put(ctx);
    this.metrics.recordAlertOutcome(this.strategy.name, 'opened');
    log.info(
      {
        model: this.strategy.name,
        symbol,
        session,
        trailMode: this.strategy.trailMode,
        entryLimitPrice,
        quantity,
        stopPrice: ctx.stopPrice,
        entryOrderId: placement.entryOrderId,
        stopOrderId: placement.stopOrderId,
      },
      'trade opened from scanner alert',
    );
    await this.reconcileEntryFill.execute({ ctx });
  }

  // percent: stop derivado del % sobre el entry (proxy del fill, mismo criterio
  // que TradeStationBrokerAdapter.placeBracketOrder). ema: EMA-derived via
  // computeEmaStop (que ya rechaza si falta historia o el stop no queda debajo
  // del entry). Devuelve undefined si ya se rechazo (con su metric+log).
  private async resolveStop(
    symbol: string,
    entryLimitPrice: number,
  ): Promise<ResolvedStop | undefined> {
    if (this.strategy.trailMode === 'percent') {
      const tsp = this.strategy.trailingStopPercent;
      return {
        stopOffset: round2(entryLimitPrice * (tsp / 100)),
        stopPrice: round2(entryLimitPrice * (1 - tsp / 100)),
      };
    }
    const stopPrice = await this.computeEmaStop(symbol, entryLimitPrice);
    if (stopPrice === undefined) return undefined;
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
      return undefined;
    }
    return { stopOffset, stopPrice };
  }

  // quantity por riesgo en $. Devuelve undefined (rechazo) si el stop es tan
  // ancho / la accion tan cara que ni 1 contrato cabe en el presupuesto.
  private guardQuantity(
    symbol: string,
    entryLimitPrice: number,
    stopOffset: number,
  ): number | undefined {
    const quantity = computeQuantity(this.strategy.riskUsd, stopOffset);
    if (quantity <= 0) {
      this.metrics.recordAlertOutcome(this.strategy.name, 'rejected');
      log.warn(
        {
          model: this.strategy.name,
          symbol,
          entryLimitPrice,
          stopOffset,
          riskUsd: this.strategy.riskUsd,
        },
        'alert dropped — risk-based size rounds to 0',
      );
      return undefined;
    }
    return quantity;
  }

  // rth+percent → trailing bracket (stop nativo de TS); rth+ema → bracket
  // clasico (StopMarket fijo, el bot lo mueve por EMA); pre (ambos) → Limit
  // DYP+ARCA (stop sintetico). Devuelve los orderIds o undefined si el broker
  // rechazo (con metric+log).
  private async placeEntry(
    session: 'pre' | 'rth',
    symbol: string,
    entryLimitPrice: number,
    quantity: number,
    stopOffset: number,
  ): Promise<Placement | undefined> {
    const accountId = this.strategy.accountId;

    if (session === 'pre') {
      const result = await this.placeLimitOrder.execute({
        symbol,
        side: 'BUY',
        quantity,
        limitPrice: entryLimitPrice,
        accountId,
        duration: 'DYP',
        route: 'ARCA',
      });
      if (
        !result.orderId ||
        result.status === 'rejected' ||
        result.status === 'cancelled' ||
        result.status === 'expired'
      ) {
        return this.rejectEntry(
          symbol,
          entryLimitPrice,
          'pre limit entry rejected by broker',
          {
            status: result.status,
            error: result.error,
            message: result.message,
          },
        );
      }
      return { entryOrderId: result.orderId };
    }

    if (this.strategy.trailMode === 'percent') {
      const result = await this.placeTrailingBracketOrder.execute({
        symbol,
        side: 'BUY',
        quantity,
        entryLimitPrice,
        trailingStopPercent: this.strategy.trailingStopPercent,
        accountId,
      });
      if (result.status === 'rejected') {
        return this.rejectEntry(
          symbol,
          entryLimitPrice,
          'trailing bracket rejected by broker',
          { error: result.error, message: result.message },
        );
      }
      return {
        entryOrderId: result.entryOrderId,
        stopOrderId: result.stopOrderId,
      };
    }

    const result = await this.placeBracketOrder.execute({
      symbol,
      side: 'BUY',
      quantity,
      entryLimitPrice,
      stopOffset,
      accountId,
    });
    if (result.status === 'rejected') {
      return this.rejectEntry(
        symbol,
        entryLimitPrice,
        'bracket (ema trail) rejected by broker',
        { error: result.error, message: result.message },
      );
    }
    return {
      entryOrderId: result.entryOrderId,
      stopOrderId: result.stopOrderId,
    };
  }

  private rejectEntry(
    symbol: string,
    entryLimitPrice: number,
    message: string,
    detail: Record<string, unknown>,
  ): undefined {
    this.metrics.recordAlertOutcome(this.strategy.name, 'rejected');
    log.warn(
      { model: this.strategy.name, symbol, entryLimitPrice, ...detail },
      message,
    );
    return undefined;
  }

  private buildContext(opts: {
    session: 'pre' | 'rth';
    symbol: string;
    entryLimitPrice: number;
    evalStart: string;
    evalEnd: string;
    stopPrice: number;
    placement: Placement;
  }): TradeContext {
    const {
      session,
      symbol,
      entryLimitPrice,
      evalStart,
      evalEnd,
      stopPrice,
      placement,
    } = opts;
    // stopPrice se persiste salvo en percent+rth: ahi el stop vive en el broker
    // como trailing nativo y no se trackea localmente.
    const includeStopPrice =
      session === 'pre' || this.strategy.trailMode === 'ema';
    return {
      model: this.strategy.name,
      accountId: this.strategy.accountId,
      symbol,
      side: 'BUY',
      entryLimitPrice,
      evalStart,
      evalEnd,
      bracket: {
        entryOrderId: placement.entryOrderId,
        stopOrderId: placement.stopOrderId,
      },
      indicators: null,
      checks: [],
      status: 'active',
      session,
      ...(includeStopPrice ? { stopPrice } : {}),
      ...(this.strategy.trailMode === 'percent' && session === 'pre'
        ? { trailingStopPercent: this.strategy.trailingStopPercent }
        : {}),
      ...(this.strategy.trailMode === 'ema'
        ? {
            emaTrailPeriod: this.strategy.emaTrailPeriod,
            emaTrailBufferBps: this.strategy.emaTrailBufferBps,
          }
        : {}),
      ...(session === 'pre' ? { syntheticExitFired: false } : {}),
    };
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
      const stop = round2(ema.value * (1 - bpsToFraction(bufferBps)));
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

// quantity = floor(riskUsd / stopOffset). Mantiene el riesgo en $ constante e
// independiente del precio. floor para no exceder el riesgo configurado. Devuelve 0
// (el caller rechaza el alert) si la accion es tan cara / el stop tan ancho que ni 1
// contrato cabe en el presupuesto de riesgo.
function computeQuantity(riskUsd: number, stopOffset: number): number {
  if (riskUsd <= 0 || stopOffset <= 0) return 0;
  return Math.floor(riskUsd / stopOffset);
}
