import type { OrderSide, Quote } from '../broker/BrokerTypes.js';
import type { MACD, VWAP } from '../indicators/IndicatorTypes.js';

export interface RuleCheck {
  name: string;
  passed: boolean;
}

export interface OrderConfig {
  quantity: number;
  stopOffset: number;
  takeProfitOffset: number;
}

export interface MarketSnapshot {
  symbol: string;
  quote: Quote;
  macd5min: MACD;
  macd1minSeries: MACD[];
  vwap1min: VWAP;
}

export type DecisionSignal =
  | {
      action: 'buy';
      symbol: string;
      side: OrderSide;
      entryLimitPrice: number;
      checks: RuleCheck[];
      snapshot: MarketSnapshot;
    }
  | { action: 'hold'; checks: RuleCheck[] };
