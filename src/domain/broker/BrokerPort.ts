import type {
  BracketOrderInput,
  BracketOrderResult,
  Order,
  OrderResult,
  OrderSide,
  Position,
  Quote,
  TrailingBracketOrderInput,
} from './BrokerTypes.js';

export interface GetQuoteInput {
  symbol: string;
}

export interface ReplaceStopPriceInput {
  orderId: string;
  stopPrice: number;
}

export interface CancelOrderInput {
  orderId: string;
}

export interface PlaceMarketOrderInput {
  symbol: string;
  quantity: number;
  side: OrderSide;
}

export interface BrokerPort {
  placeBracketOrder(input: BracketOrderInput): Promise<BracketOrderResult>;
  placeTrailingBracketOrder(
    input: TrailingBracketOrderInput,
  ): Promise<BracketOrderResult>;
  getPositions(): Promise<Position[]>;
  getOrders({ symbol }: { symbol?: string }): Promise<Order[]>;
  getQuote(input: GetQuoteInput): Promise<Quote>;
  replaceStopPrice(input: ReplaceStopPriceInput): Promise<void>;
  cancelOrder(input: CancelOrderInput): Promise<void>;
  placeMarketOrder(input: PlaceMarketOrderInput): Promise<OrderResult>;
}
