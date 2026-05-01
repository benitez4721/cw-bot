import type { WatchedSymbol } from './WatchlistTypes.js';

export interface WatchlistRepository {
  insert(symbol: WatchedSymbol): void;
  update(symbol: WatchedSymbol): void;
  getBySymbol(symbol: string): WatchedSymbol | undefined;
  list(): WatchedSymbol[];
}
