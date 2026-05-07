import type { Bar, BarInterval } from './MarketDataTypes.js';

export interface FetchHistoricalBarsInput {
  symbol: string;
  interval: BarInterval;
  limit: number;
}

export type BarHandler = (symbol: string, bar: Bar) => void;
export type ConnectionHandler = (connected: boolean) => void;

export interface MarketFeedPort {
  fetchHistoricalBars(input: FetchHistoricalBarsInput): Promise<Bar[]>;
  connect(): Promise<void>;
  disconnect(): void;
  subscribe(symbol: string): void;
  unsubscribe(symbol: string): void;
  onBar(handler: BarHandler): void;
  onConnectionChange(handler: ConnectionHandler): void;
}
