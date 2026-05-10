import type { TradeContext } from './TradeTypes.js';

export interface TradeContextRepository {
  put(ctx: TradeContext): Promise<void>;
  getByOrderId(orderId: string): Promise<TradeContext | undefined>;
  getByOrderIds(orderIds: string[]): Promise<Map<string, TradeContext>>;
  listActiveByModelAndSymbol(
    model: string,
    symbol: string,
  ): Promise<TradeContext[]>;
}
