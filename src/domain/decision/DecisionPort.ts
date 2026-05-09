import type { DecisionSignal, OrderConfig } from './DecisionTypes.js';

export interface BuildSnapshotInput {
  symbol: string;
}

export interface EvaluateInput<TSnapshot> {
  snapshot: TSnapshot;
}

export interface DecisionModelPort<TSnapshot = unknown> {
  readonly name: string;
  readonly orderConfig: OrderConfig;
  buildSnapshot(input: BuildSnapshotInput): Promise<TSnapshot>;
  evaluate(input: EvaluateInput<TSnapshot>): DecisionSignal<TSnapshot>;
}
