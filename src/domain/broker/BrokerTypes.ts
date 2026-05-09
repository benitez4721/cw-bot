import type { TradeContext } from '../trade/TradeTypes.js';

export type OrderType = 'Market' | 'Limit' | 'StopMarket' | 'StopLimit';
export type OrderSide = 'BUY' | 'SELL';
export type OrderStatus =
  | 'pending'
  | 'open'
  | 'filled'
  | 'partiallyFilled'
  | 'cancelled'
  | 'rejected'
  | 'expired';

export interface OrderResult {
  orderId: string;
  status: OrderStatus;
  message?: string;
  error?: string;
}

export interface Order {
  id: string;
  symbol: string;
  quantity: number;
  side: OrderSide;
  type: OrderType;
  status: OrderStatus;
  filledQuantity?: number;
  limitPrice?: number;
  stopPrice?: number;
  createdAt: string;
}

export interface Position {
  symbol: string;
  quantity: number;
  averagePrice: number;
  marketValue: number;
  unrealizedPnL: number;
}

export interface Quote {
  symbol: string;
  last: number;
  bid?: number;
  ask?: number;
  timestamp: string;
}

export interface BracketOrderInput {
  symbol: string;
  quantity: number;
  side: OrderSide;
  entryLimitPrice: number;
  stopOffset: number;
  takeProfitOffset: number;
}

export interface BracketOrderResult {
  status: OrderStatus;
  entryOrderId: string;
  stopOrderId: string;
  takeProfitOrderId: string;
  message?: string;
  error?: string;
}

export type OrderWithContext = Order & { context?: TradeContext };
