import type {
  BracketOrderInput,
  BracketOrderResult,
  Order,
  Position,
  Quote,
} from './BrokerTypes.js';

export interface GetQuoteInput {
  symbol: string;
}

export interface BrokerPort {
  placeBracketOrder(input: BracketOrderInput): Promise<BracketOrderResult>;
  getPositions(): Promise<Position[]>;
  getOrders({ symbol }: { symbol?: string }): Promise<Order[]>;
  getQuote(input: GetQuoteInput): Promise<Quote>;
}
