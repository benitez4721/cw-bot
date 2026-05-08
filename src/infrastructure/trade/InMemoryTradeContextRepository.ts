import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../domain/trade/TradeTypes.js';

export class InMemoryTradeContextRepository implements TradeContextRepository {
  private readonly contexts = new Map<string, TradeContext>();

  async put(ctx: TradeContext): Promise<void> {
    this.contexts.set(ctx.orderId, ctx);
  }

  async getByOrderIds(orderIds: string[]): Promise<Map<string, TradeContext>> {
    const result = new Map<string, TradeContext>();
    for (const id of orderIds) {
      const ctx = this.contexts.get(id);
      if (ctx) result.set(id, ctx);
    }
    return result;
  }
}
