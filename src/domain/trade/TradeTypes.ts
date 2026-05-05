import type { OrderSide, Quote } from '../broker/BrokerTypes.js';
import type { RuleCheck } from '../decision/DecisionTypes.js';
import type { MACD, VWAP } from '../indicators/IndicatorTypes.js';

export type TradeContextStatus = 'active' | 'closed';

export interface TradeIndicatorSnapshot {
  quote: Quote;
  macd5min: MACD;
  macd1min: MACD;
  macd1minPrevious?: MACD;
  vwap1min: VWAP;
}

export interface TradeContext {
  orderId: string;
  symbol: string;
  side: OrderSide;
  entryLimitPrice: number;
  placedAt: string;
  indicators: TradeIndicatorSnapshot;
  checks: RuleCheck[];
  status: TradeContextStatus;
}
