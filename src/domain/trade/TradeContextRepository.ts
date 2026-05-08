import type { TradeContext } from './TradeTypes.js';

export interface TradeContextRepository {
  put(ctx: TradeContext): Promise<void>;
  getByOrderIds(orderIds: string[]): Promise<Map<string, TradeContext>>;
}
