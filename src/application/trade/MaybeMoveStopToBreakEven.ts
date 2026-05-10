import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import { logger } from '../../infrastructure/logging/logger.js';

const log = logger.child({ component: 'MaybeMoveStopToBreakEven' });

export interface MaybeMoveStopToBreakEvenInput {
  model: string;
  symbol: string;
  lastPrice: number;
  threshold: number;
}

export interface MaybeMoveStopToBreakEvenDeps {
  tradeRepo: TradeContextRepository;
  broker: BrokerPort;
}

// One-shot trail: for every active trade of (model, symbol) whose unrealized
// profit fraction is >= threshold and that has not yet been trailed, replaces
// its stop order's stopPrice with the entry price and persists breakEvenMoved.
//
// Idempotent: contexts with breakEvenMoved already set are skipped. If the
// broker call fails (order already filled/cancelled, network), we log and
// keep breakEvenMoved unset so the next bar can retry; CheckOpenTrades will
// eventually close the context if the bracket is gone.
export class MaybeMoveStopToBreakEven {
  private readonly tradeRepo: TradeContextRepository;
  private readonly broker: BrokerPort;

  constructor(deps: MaybeMoveStopToBreakEvenDeps) {
    this.tradeRepo = deps.tradeRepo;
    this.broker = deps.broker;
  }

  async execute({
    model,
    symbol,
    lastPrice,
    threshold,
  }: MaybeMoveStopToBreakEvenInput): Promise<void> {
    const contexts = await this.tradeRepo.listActiveByModelAndSymbol(
      model,
      symbol,
    );
    for (const ctx of contexts) {
      if (ctx.breakEvenMoved) continue;
      const profitPct = profitFraction(
        ctx.side,
        ctx.entryLimitPrice,
        lastPrice,
      );
      if (profitPct < threshold) continue;

      try {
        await this.broker.replaceStopPrice({
          orderId: ctx.bracket.stopOrderId,
          stopPrice: ctx.entryLimitPrice,
        });
        await this.tradeRepo.put({ ...ctx, breakEvenMoved: true });
        log.info(
          {
            model,
            symbol,
            entryOrderId: ctx.bracket.entryOrderId,
            stopOrderId: ctx.bracket.stopOrderId,
            entry: ctx.entryLimitPrice,
            profitPct,
          },
          'stop moved to break-even',
        );
      } catch (err) {
        log.warn(
          {
            model,
            symbol,
            stopOrderId: ctx.bracket.stopOrderId,
            err: err instanceof Error ? err.message : String(err),
          },
          'failed to move stop to break-even — will retry next bar',
        );
      }
    }
  }
}

function profitFraction(
  side: 'BUY' | 'SELL',
  entry: number,
  last: number,
): number {
  if (entry <= 0) return 0;
  return side === 'BUY' ? (last - entry) / entry : (entry - last) / entry;
}
