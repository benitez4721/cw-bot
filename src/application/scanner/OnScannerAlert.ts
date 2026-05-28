import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { EventStrategy } from '../../domain/decision/EventStrategy.js';
import type { MarketHours } from '../../domain/market/MarketHours.js';
import type { MetricsPort } from '../../domain/metrics/MetricsPort.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../domain/trade/TradeTypes.js';
import { logger } from '../../infrastructure/logging/logger.js';
import type { PlaceLimitOrder } from '../broker/PlaceLimitOrder.js';
import type { PlaceTrailingBracketOrder } from '../broker/PlaceTrailingBracketOrder.js';
import type { CheckOpenTrades } from '../trade/CheckOpenTrades.js';

const log = logger.child({ component: 'OnScannerAlert' });

export interface OnScannerAlertDeps {
  strategy: EventStrategy;
  broker: BrokerPort;
  placeTrailingBracketOrder: PlaceTrailingBracketOrder;
  // Usado en sesion pre. En RTH se usa placeTrailingBracketOrder (bracket
  // con trailing nativo del broker); en pre el broker no soporta trailing
  // ni OSO, asi que mandamos un Limit DYP+ARCA y gestionamos el stop
  // sinteticamente via MaybeTrailSyntheticStop + CheckSyntheticStops.
  placeLimitOrder: PlaceLimitOrder;
  tradeRepo: TradeContextRepository;
  checkOpenTrades: CheckOpenTrades;
  marketHours: MarketHours;
  metrics: MetricsPort;
  now?: () => string;
}

export class OnScannerAlert {
  private readonly strategy: EventStrategy;
  private readonly broker: BrokerPort;
  private readonly placeTrailingBracketOrder: PlaceTrailingBracketOrder;
  private readonly placeLimitOrder: PlaceLimitOrder;
  private readonly tradeRepo: TradeContextRepository;
  private readonly checkOpenTrades: CheckOpenTrades;
  private readonly marketHours: MarketHours;
  private readonly metrics: MetricsPort;
  private readonly now: () => string;

  constructor(deps: OnScannerAlertDeps) {
    this.strategy = deps.strategy;
    this.broker = deps.broker;
    this.placeTrailingBracketOrder = deps.placeTrailingBracketOrder;
    this.placeLimitOrder = deps.placeLimitOrder;
    this.tradeRepo = deps.tradeRepo;
    this.checkOpenTrades = deps.checkOpenTrades;
    this.marketHours = deps.marketHours;
    this.metrics = deps.metrics;
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
    if (session === 'rth') {
      await this.openRth(symbol, entryLimitPrice, evalStart);
    } else {
      await this.openPre(symbol, entryLimitPrice, evalStart);
    }
  }

  private async openRth(
    symbol: string,
    entryLimitPrice: number,
    evalStart: string,
  ): Promise<void> {
    if (this.strategy.trailMode !== 'percent') {
      throw new Error(
        `openRth invoked with trailMode=${this.strategy.trailMode}; expected 'percent'`,
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
      'trade opened from scanner alert (rth)',
    );
  }

  private async openPre(
    symbol: string,
    entryLimitPrice: number,
    evalStart: string,
  ): Promise<void> {
    if (this.strategy.trailMode !== 'percent') {
      throw new Error(
        `openPre invoked with trailMode=${this.strategy.trailMode}; expected 'percent'`,
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
      'trade opened from scanner alert (pre)',
    );
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
