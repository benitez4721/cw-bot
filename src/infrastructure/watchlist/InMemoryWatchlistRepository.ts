import type { WatchlistRepository } from '../../domain/watchlist/WatchlistRepository.js';
import type { WatchedSymbol } from '../../domain/watchlist/WatchlistTypes.js';

export class InMemoryWatchlistRepository implements WatchlistRepository {
  private readonly symbols = new Map<string, WatchedSymbol>();

  async insert(symbol: WatchedSymbol): Promise<void> {
    if (this.symbols.has(symbol.symbol)) {
      throw new Error(`Symbol already in watchlist: ${symbol.symbol}`);
    }
    this.symbols.set(symbol.symbol, symbol);
  }

  async update(symbol: WatchedSymbol): Promise<void> {
    if (!this.symbols.has(symbol.symbol)) {
      throw new Error(`Symbol not in watchlist: ${symbol.symbol}`);
    }
    this.symbols.set(symbol.symbol, symbol);
  }

  async getBySymbol(symbol: string): Promise<WatchedSymbol | undefined> {
    return this.symbols.get(symbol);
  }

  async list(): Promise<WatchedSymbol[]> {
    return Array.from(this.symbols.values());
  }
}
