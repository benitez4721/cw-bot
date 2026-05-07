import type { Bar, BarInterval } from './MarketDataTypes.js';

export interface BarRepository {
  get(symbol: string, interval: BarInterval, limit?: number): Promise<Bar[]>;
  set(symbol: string, interval: BarInterval, bars: Bar[]): Promise<void>;
  append(symbol: string, interval: BarInterval, bar: Bar): Promise<void>;
  delete(symbol: string): Promise<void>;
}
