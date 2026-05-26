import type {
  BracketOrderInput,
  BracketOrderResult,
  Order,
  OrderResult,
  OrderSide,
  PlaceLimitOrderInput,
  Position,
  Quote,
  TrailingBracketOrderInput,
} from './BrokerTypes.js';

// Todos los inputs requieren accountId explícito. El BrokerPort es
// account-agnostic: cada call indica contra qué cuenta opera. No hay default
// implícito — el caller (BarStreamManager / OnScannerAlert / use cases que
// resuelven contra ctx.accountId) debe proveerlo.

export interface GetQuoteInput {
  symbol: string;
  // accountId solo se usa para decidir SIM vs LIVE (los quotes US son los
  // mismos en ambos ambientes); igual hay que proveerlo.
  accountId: string;
}

export interface ReplaceStopPriceInput {
  orderId: string;
  stopPrice: number;
  // accountId requerido para resolver el apiBase correcto. El path REST no
  // lo lleva (el endpoint es por orderId) pero pegarle al ambiente
  // equivocado devuelve 404.
  accountId: string;
}

export interface CancelOrderInput {
  orderId: string;
  accountId: string;
}

export interface PlaceMarketOrderInput {
  symbol: string;
  quantity: number;
  side: OrderSide;
  accountId: string;
}

export interface GetOrdersInput {
  symbol?: string;
  accountId: string;
}

export interface GetPositionsInput {
  accountId: string;
}

export interface BrokerPort {
  placeBracketOrder(input: BracketOrderInput): Promise<BracketOrderResult>;
  placeTrailingBracketOrder(
    input: TrailingBracketOrderInput,
  ): Promise<BracketOrderResult>;
  getPositions(input: GetPositionsInput): Promise<Position[]>;
  getOrders(input: GetOrdersInput): Promise<Order[]>;
  getQuote(input: GetQuoteInput): Promise<Quote>;
  replaceStopPrice(input: ReplaceStopPriceInput): Promise<void>;
  cancelOrder(input: CancelOrderInput): Promise<void>;
  placeMarketOrder(input: PlaceMarketOrderInput): Promise<OrderResult>;
  placeLimitOrder(input: PlaceLimitOrderInput): Promise<OrderResult>;
}
