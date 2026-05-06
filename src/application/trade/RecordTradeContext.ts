import type { DecisionSignal } from '../../domain/decision/DecisionTypes.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import type {
  TradeContext,
  TradeIndicatorSnapshot,
} from '../../domain/trade/TradeTypes.js';

type BuySignal = Extract<DecisionSignal, { action: 'buy' }>;

export interface RecordTradeContextInput {
  orderId: string;
  signal: BuySignal;
  evalStart: string;
  evalEnd: string;
}

export class RecordTradeContext {
  constructor(private readonly repository: TradeContextRepository) {}

  async execute({
    orderId,
    signal,
    evalStart,
    evalEnd,
  }: RecordTradeContextInput): Promise<void> {
    if (!orderId) throw new Error('orderId is required');

    const indicators: TradeIndicatorSnapshot = {
      quote: signal.snapshot.quote,
      macd5min: signal.snapshot.macd5min,
      macd1min: signal.snapshot.macd1minSeries[0],
      macd1minPrevious: signal.snapshot.macd1minSeries[1],
      vwap1min: signal.snapshot.vwap1min,
    };

    const ctx: TradeContext = {
      orderId,
      symbol: signal.symbol,
      side: signal.side,
      entryLimitPrice: signal.entryLimitPrice,
      evalStart,
      evalEnd,
      indicators,
      checks: signal.checks,
      status: 'active',
    };

    await this.repository.insert(ctx);
  }
}
