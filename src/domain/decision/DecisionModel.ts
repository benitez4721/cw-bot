import type { Bar } from '../marketdata/MarketDataTypes.js';
import type { DecisionSignal } from './DecisionTypes.js';

export interface BuildSnapshotInput {
  symbol: string;
  triggerBar?: Bar;
}

export interface DecisionModel<TSnapshot = unknown> {
  readonly name: string;
  buildSnapshot(input: BuildSnapshotInput): Promise<TSnapshot>;
  evaluate(snapshot: TSnapshot): DecisionSignal<TSnapshot>;
}
