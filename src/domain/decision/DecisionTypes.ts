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

export type DecisionSignal<TSnapshot = unknown> =
  | {
      action: 'buy';
      symbol: string;
      side: OrderSide;
      entryLimitPrice: number;
      // Optional dynamic order sizing: when set, BarStreamManager prefers these
      // over the strategy's static OrderConfig. Lets a model size per-symbol
      // (e.g. floor(notional / last)) and use percentage-based offsets.
      quantity?: number;
      stopOffset?: number;
      takeProfitOffset?: number;
      checks: RuleCheck[];
      snapshot: TSnapshot;
    }
  | { action: 'hold'; checks: RuleCheck[]; snapshot: TSnapshot };
