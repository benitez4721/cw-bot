import type { Bar } from '../marketdata/MarketDataTypes.js';
import type { DecisionSignal } from './DecisionTypes.js';

export interface BuildSnapshotInput {
  symbol: string;
  // Cuenta TradeStation contra la que se resuelven las queries del modelo
  // (getQuote, etc). La strategy la pasa per-call para que el modelo no
  // tenga que guardar estado de cuenta.
  accountId: string;
  triggerBar?: Bar;
}

export interface DecisionModel<TSnapshot = unknown> {
  readonly name: string;
  buildSnapshot(input: BuildSnapshotInput): Promise<TSnapshot>;
  evaluate(snapshot: TSnapshot): DecisionSignal<TSnapshot>;
}
