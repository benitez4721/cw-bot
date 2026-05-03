import type { Quote } from '../broker/BrokerTypes.js';
import type { MACD, VWAP } from '../indicators/IndicatorTypes.js';
import type { DecisionSignal } from './DecisionTypes.js';

export interface MarketSnapshot {
  symbol: string;
  quote: Quote;
  macd5min: MACD;
  macd1minSeries: MACD[];
  vwap1min: VWAP;
}

export interface EvaluateInput {
  snapshot: MarketSnapshot;
}

export interface DecisionModelPort {
  readonly name: string;
  evaluate(input: EvaluateInput): DecisionSignal;
}
