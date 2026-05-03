import type { WatchlistRepository } from '../../domain/watchlist/WatchlistRepository.js';
import type { WatchedSymbol } from '../../domain/watchlist/WatchlistTypes.js';

export class ListWatchlist {
  constructor(private readonly repository: WatchlistRepository) {}

  execute(): Promise<WatchedSymbol[]> {
    return this.repository.list();
  }
}
