import type { OrderSide } from '../broker/BrokerTypes.js';

export interface RuleCheck {
  name: string;
  passed: boolean;
}

export type DecisionSignal<TSnapshot = unknown> =
  | {
      action: 'buy';
      symbol: string;
      side: OrderSide;
      entryLimitPrice: number;
      quantity: number;
      stopOffset: number;
      takeProfitOffset: number;
      checks: RuleCheck[];
      snapshot: TSnapshot;
    }
  | { action: 'hold'; checks: RuleCheck[]; snapshot: TSnapshot };
