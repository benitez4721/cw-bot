import type { Bar } from '../marketdata/MarketDataTypes.js';
import type { DecisionSignal, OrderConfig } from './DecisionTypes.js';

export interface BuildSnapshotInput {
  symbol: string;
  // The 1m bar whose close triggered this evaluation. Models that gate on
  // bar-boundary semantics (e.g. only act on 5m bucket closes) need this.
  triggerBar?: Bar;
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
