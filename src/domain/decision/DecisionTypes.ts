import type { OrderSide } from '../broker/BrokerTypes.js';

export interface RuleCheck {
  name: string;
  passed: boolean;
}

export interface OrderPlan {
  symbol: string;
  side: OrderSide;
  quantity: number;
  entryLimitPrice: number;
  stopOffset: number;
  takeProfitOffset: number;
}

export type DecisionSignal =
  | { action: 'buy'; plan: OrderPlan; checks: RuleCheck[] }
  | { action: 'hold'; checks: RuleCheck[] };
