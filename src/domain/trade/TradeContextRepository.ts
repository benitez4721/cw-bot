import type { TradeContext } from './TradeTypes.js';

export interface TradeContextRepository {
  put(ctx: TradeContext): Promise<void>;
  getByOrderId(orderId: string): Promise<TradeContext | undefined>;
  getByOrderIds(orderIds: string[]): Promise<Map<string, TradeContext>>;
  listActiveByModel(model: string): Promise<TradeContext[]>;
  // Cross-model / cross-symbol — usado por el flatten pre-close.
  listAllActive(): Promise<TradeContext[]>;
}
