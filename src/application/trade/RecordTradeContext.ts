import type { DecisionSignal } from '../../domain/decision/DecisionTypes.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import type {
  TradeContext,
  TradeContextBracket,
} from '../../domain/trade/TradeTypes.js';

type BuySignal = Extract<DecisionSignal<unknown>, { action: 'buy' }>;

export interface RecordTradeContextInput {
  model: string;
  bracket: TradeContextBracket;
  signal: BuySignal;
  evalStart: string;
  evalEnd: string;
}

export class RecordTradeContext {
  constructor(private readonly repository: TradeContextRepository) {}

  async execute({
    model,
    bracket,
    signal,
    evalStart,
    evalEnd,
  }: RecordTradeContextInput): Promise<void> {
    if (!bracket.entryOrderId)
      throw new Error('bracket.entryOrderId is required');
    if (!model) throw new Error('model is required');

    const ctx: TradeContext = {
      model,
      symbol: signal.symbol,
      side: signal.side,
      entryLimitPrice: signal.entryLimitPrice,
      evalStart,
      evalEnd,
      bracket,
      indicators: signal.snapshot,
      checks: signal.checks,
      status: 'active',
    };

    await this.repository.put(ctx);
  }
}
