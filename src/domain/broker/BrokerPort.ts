import type {
  Balance,
  HistoricalOrder,
  Order,
  OrderResult,
  PlaceOrderInput,
  Position,
  Quote,
} from './BrokerTypes.js';

export interface GetQuoteInput {
  symbol: string;
}

export interface BrokerPort {
  placeOrder(input: PlaceOrderInput): Promise<OrderResult>;
  cancelOrder({ orderId }: { orderId: string }): Promise<OrderResult>;
  replaceOrder({
    orderId,
    order,
  }: {
    orderId: string;
    order: PlaceOrderInput;
  }): Promise<OrderResult>;
  getBalances(): Promise<Balance>;
  getPositions(): Promise<Position[]>;
  getOrders({ symbol }: { symbol?: string }): Promise<Order[]>;
  getHistoricalOrders({ since }: { since: string }): Promise<HistoricalOrder[]>;
  getQuote(input: GetQuoteInput): Promise<Quote>;
}
