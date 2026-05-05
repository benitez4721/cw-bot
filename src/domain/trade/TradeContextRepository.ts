import type { TradeContext } from './TradeTypes.js';

export interface TradeContextRepository {
  insert(ctx: TradeContext): Promise<void>;
  getByOrderId(orderId: string): Promise<TradeContext | undefined>;
  getByOrderIds(orderIds: string[]): Promise<Map<string, TradeContext>>;
}
