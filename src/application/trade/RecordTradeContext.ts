import type { DecisionSignal } from '../../domain/decision/DecisionTypes.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../domain/trade/TradeTypes.js';

type BuySignal = Extract<DecisionSignal<unknown>, { action: 'buy' }>;

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

    const ctx: TradeContext = {
      orderId,
      symbol: signal.symbol,
      side: signal.side,
      entryLimitPrice: signal.entryLimitPrice,
      evalStart,
      evalEnd,
      indicators: signal.snapshot,
      checks: signal.checks,
      status: 'active',
    };

    await this.repository.put(ctx);
  }
}
