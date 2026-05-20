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
  // accountId solo se usa para decidir SIM vs LIVE (los quotes US son los
  // mismos en ambos ambientes). Si se omite, el adapter usa el default.
  accountId?: string;
}

export interface ReplaceStopPriceInput {
  orderId: string;
  stopPrice: number;
  // accountId requerido para resolver el apiBase correcto. El path REST no
  // lo lleva (el endpoint es por orderId) pero pegarle al ambiente
  // equivocado devuelve 404.
  accountId?: string;
}

export interface CancelOrderInput {
  orderId: string;
  accountId?: string;
}

export interface PlaceMarketOrderInput {
  symbol: string;
  quantity: number;
  side: OrderSide;
  accountId?: string;
}

export interface GetOrdersInput {
  symbol?: string;
  accountId?: string;
}

export interface GetPositionsInput {
  accountId?: string;
}

export interface BrokerPort {
  placeBracketOrder(input: BracketOrderInput): Promise<BracketOrderResult>;
  placeTrailingBracketOrder(
    input: TrailingBracketOrderInput,
  ): Promise<BracketOrderResult>;
  getPositions(input?: GetPositionsInput): Promise<Position[]>;
  getOrders(input: GetOrdersInput): Promise<Order[]>;
  getQuote(input: GetQuoteInput): Promise<Quote>;
  replaceStopPrice(input: ReplaceStopPriceInput): Promise<void>;
  cancelOrder(input: CancelOrderInput): Promise<void>;
  placeMarketOrder(input: PlaceMarketOrderInput): Promise<OrderResult>;
}
