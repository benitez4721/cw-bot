import type { Bar } from '../marketdata/MarketDataTypes.js';
import type { ScannerColumn } from '../scanner/ScannerTypes.js';
import type { DecisionSignal } from './DecisionTypes.js';

export interface BuildSnapshotInput {
  symbol: string;
  // Cuenta TradeStation contra la que se resuelven las queries del modelo
  // (getQuote, etc). La strategy la pasa per-call para que el modelo no
  // tenga que guardar estado de cuenta.
  accountId: string;
  triggerBar?: Bar;
  // Solo poblado por flujos event-driven (EventStrategy con DecisionModel).
  // Los modelos invocados desde BarStreamManager lo dejan undefined; los
  // modelos que filtran por columnas del NewAlert lo leen acá. Es opcional
  // para no forzar un puerto paralelo.
  columns?: readonly ScannerColumn[];
}

export interface DecisionModel<TSnapshot = unknown> {
  readonly name: string;
  buildSnapshot(input: BuildSnapshotInput): Promise<TSnapshot>;
  evaluate(snapshot: TSnapshot): DecisionSignal<TSnapshot>;
}
