import type { WatchedSymbol } from './WatchlistTypes.js';

export interface WatchlistRepository {
  put(symbol: WatchedSymbol): Promise<void>;
  getBySymbol(symbol: string): Promise<WatchedSymbol | undefined>;
  list(): Promise<WatchedSymbol[]>;
}
