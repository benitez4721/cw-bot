import type {
  DecisionSignal,
  MarketSnapshot,
  OrderConfig,
} from './DecisionTypes.js';

export type { MarketSnapshot };

export interface EvaluateInput {
  snapshot: MarketSnapshot;
}

export interface DecisionModelPort {
  readonly name: string;
  readonly orderConfig: OrderConfig;
  evaluate(input: EvaluateInput): DecisionSignal;
}
