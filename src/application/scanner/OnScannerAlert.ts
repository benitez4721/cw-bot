import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { EventStrategy } from '../../domain/decision/EventStrategy.js';
import type { MetricsPort } from '../../domain/metrics/MetricsPort.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../domain/trade/TradeTypes.js';
import { logger } from '../../infrastructure/logging/logger.js';
import type { PlaceTrailingBracketOrder } from '../broker/PlaceTrailingBracketOrder.js';
import type { CheckOpenTrades } from '../trade/CheckOpenTrades.js';

const log = logger.child({ component: 'OnScannerAlert' });

export interface OnScannerAlertDeps {
  strategy: EventStrategy;
  broker: BrokerPort;
  placeTrailingBracketOrder: PlaceTrailingBracketOrder;
  tradeRepo: TradeContextRepository;
  checkOpenTrades: CheckOpenTrades;
  metrics: MetricsPort;
  now?: () => string;
}

export class OnScannerAlert {
  private readonly strategy: EventStrategy;
  private readonly broker: BrokerPort;
  private readonly placeTrailingBracketOrder: PlaceTrailingBracketOrder;
  private readonly tradeRepo: TradeContextRepository;
  private readonly checkOpenTrades: CheckOpenTrades;
  private readonly metrics: MetricsPort;
  private readonly now: () => string;

  constructor(deps: OnScannerAlertDeps) {
    this.strategy = deps.strategy;
    this.broker = deps.broker;
    this.placeTrailingBracketOrder = deps.placeTrailingBracketOrder;
    this.tradeRepo = deps.tradeRepo;
    this.checkOpenTrades = deps.checkOpenTrades;
    this.metrics = deps.metrics;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async handle(symbol: string): Promise<void> {
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

    const quote = await this.broker.getQuote({ symbol });
    const reference = quote.ask ?? quote.last;
    if (!Number.isFinite(reference) || reference <= 0) {
      this.metrics.recordAlertOutcome(this.strategy.name, 'rejected');
      log.warn(
        { model: this.strategy.name, symbol, quote },
        'alert dropped — quote has no usable ask/last',
      );
      return;
    }
    const entryLimitPrice =
      reference * (1 + this.strategy.entryBufferBps / 10_000);

    const evalStart = this.now();
    const result = await this.placeTrailingBracketOrder.execute({
      symbol,
      side: 'BUY',
      quantity: this.strategy.quantity,
      entryLimitPrice,
      trailingStopPercent: this.strategy.trailingStopPercent,
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
      'trade opened from scanner alert',
    );
  }
}
