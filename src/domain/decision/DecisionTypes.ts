import type { OrderSide } from '../broker/BrokerTypes.js';

export interface RuleCheck {
  name: string;
  passed: boolean;
}

export interface OrderConfig {
  quantity: number;
  stopOffset: number;
  takeProfitOffset: number;
}

export type DecisionSignal =
  | {
      action: 'buy';
      symbol: string;
      side: OrderSide;
      entryLimitPrice: number;
      checks: RuleCheck[];
    }
  | { action: 'hold'; checks: RuleCheck[] };
