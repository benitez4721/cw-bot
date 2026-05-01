import type { WatchlistRepository } from '../../domain/watchlist/WatchlistRepository.js';
import type { WatchedSymbol } from '../../domain/watchlist/WatchlistTypes.js';

export class InMemoryWatchlistRepository implements WatchlistRepository {
  private readonly symbols = new Map<string, WatchedSymbol>();

  insert(symbol: WatchedSymbol): void {
    if (this.symbols.has(symbol.symbol)) {
      throw new Error(`Symbol already in watchlist: ${symbol.symbol}`);
    }
    this.symbols.set(symbol.symbol, symbol);
  }

  update(symbol: WatchedSymbol): void {
    if (!this.symbols.has(symbol.symbol)) {
      throw new Error(`Symbol not in watchlist: ${symbol.symbol}`);
    }
    this.symbols.set(symbol.symbol, symbol);
  }

  getBySymbol(symbol: string): WatchedSymbol | undefined {
    return this.symbols.get(symbol);
  }

  list(): WatchedSymbol[] {
    return Array.from(this.symbols.values());
  }
}
