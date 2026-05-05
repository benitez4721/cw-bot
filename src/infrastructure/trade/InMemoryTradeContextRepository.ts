import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../domain/trade/TradeTypes.js';

export class InMemoryTradeContextRepository implements TradeContextRepository {
  private readonly contexts = new Map<string, TradeContext>();

  async insert(ctx: TradeContext): Promise<void> {
    this.contexts.set(ctx.orderId, ctx);
  }

  async getByOrderId(orderId: string): Promise<TradeContext | undefined> {
    return this.contexts.get(orderId);
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
