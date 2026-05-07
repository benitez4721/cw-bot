import type { Bar, BarInterval } from './MarketDataTypes.js';

export interface FetchHistoricalBarsInput {
  symbol: string;
  interval: BarInterval;
  limit: number;
}

export interface HistoricalBarsPort {
  fetchHistoricalBars(input: FetchHistoricalBarsInput): Promise<Bar[]>;
}
