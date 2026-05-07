import type { Bar } from './MarketDataTypes.js';

export type BarHandler = (symbol: string, bar: Bar) => void;
export type ConnectionHandler = (connected: boolean) => void;

// Realtime feed only. Historical bootstrap lives in HistoricalBarsPort
// (currently backed by Twelve Data). Polygon implements this port via the
// stocks WS, channel AM (1-minute aggregates published at minute close).
export interface MarketFeedPort {
  connect(): Promise<void>;
  disconnect(): void;
  subscribe(symbol: string): void;
  unsubscribe(symbol: string): void;
  onBar(handler: BarHandler): void;
  onConnectionChange(handler: ConnectionHandler): void;
}
