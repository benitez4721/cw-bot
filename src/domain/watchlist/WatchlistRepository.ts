import type { WatchedSymbol } from './WatchlistTypes.js';

export interface WatchlistRepository {
  insert(symbol: WatchedSymbol): Promise<void>;
  update(symbol: WatchedSymbol): Promise<void>;
  getBySymbol(symbol: string): Promise<WatchedSymbol | undefined>;
  list(): Promise<WatchedSymbol[]>;
}
