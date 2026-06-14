import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { EventStrategy } from '../../domain/decision/EventStrategy.js';
import type { IndicatorPort } from '../../domain/indicators/IndicatorPort.js';
import type { MarketHours } from '../../domain/market/MarketHours.js';
import type { BarRepository } from '../../domain/marketdata/BarRepository.js';
import type { HistoricalBarsPort } from '../../domain/marketdata/HistoricalBarsPort.js';
import type { MetricsPort } from '../../domain/metrics/MetricsPort.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { bpsToFraction } from '../../domain/shared/math.js';
import type { PlaceBracketOrder } from '../broker/PlaceBracketOrder.js';
import type { PlaceLimitOrder } from '../broker/PlaceLimitOrder.js';
import type { PlaceTrailingBracketOrder } from '../broker/PlaceTrailingBracketOrder.js';
import type { CheckOpenTrades } from '../trade/CheckOpenTrades.js';
import { OpenEventTrade } from '../trade/OpenEventTrade.js';
import type { ReconcileEntryFill } from '../trade/ReconcileEntryFill.js';

const log = logger.child({ component: 'OnScannerAlert' });

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

// Maneja un alert del scanner para una EventStrategy: decide si es accionable
// (sesion tradeable, sin exposicion previa, quote usable) y, de serlo, delega
// la apertura del trade en OpenEventTrade. La mecanica de stop/sizing/orden/
// persistencia vive en ese caso de uso; aca solo queda el gating del alert.
export class OnScannerAlert {
  private readonly strategy: EventStrategy;
  private readonly broker: BrokerPort;
  private readonly checkOpenTrades: CheckOpenTrades;
  private readonly marketHours: MarketHours;
  private readonly metrics: MetricsPort;
  private readonly now: () => string;
  private readonly openEventTrade: OpenEventTrade;

  constructor(deps: OnScannerAlertDeps) {
    this.strategy = deps.strategy;
    this.broker = deps.broker;
    this.checkOpenTrades = deps.checkOpenTrades;
    this.marketHours = deps.marketHours;
    this.metrics = deps.metrics;
    this.now = deps.now ?? (() => new Date().toISOString());
    this.openEventTrade = new OpenEventTrade({
      strategy: deps.strategy,
      placeTrailingBracketOrder: deps.placeTrailingBracketOrder,
      placeBracketOrder: deps.placeBracketOrder,
      placeLimitOrder: deps.placeLimitOrder,
      tradeRepo: deps.tradeRepo,
      reconcileEntryFill: deps.reconcileEntryFill,
      metrics: deps.metrics,
      indicators: deps.indicators,
      barRepo: deps.barRepo,
      historicalBars: deps.historicalBars,
      now: this.now,
    });
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
      reference * (1 + bpsToFraction(this.strategy.entryBufferBps));

    const evalStart = this.now();
    await this.openEventTrade.execute({
      symbol,
      entryLimitPrice,
      evalStart,
      session,
    });
  }
}
