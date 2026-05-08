import type { TradeContext } from './TradeTypes.js';

export interface TradeContextRepository {
  insert(ctx: TradeContext): Promise<void>;
  getByOrderIds(orderIds: string[]): Promise<Map<string, TradeContext>>;
}
