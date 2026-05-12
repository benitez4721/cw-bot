import type { WatchlistRepository } from '../../domain/watchlist/WatchlistRepository.js';
import type { WatchedSymbol } from '../../domain/watchlist/WatchlistTypes.js';

export interface ModelWatchlist {
  name: string;
  repository: WatchlistRepository;
}

export interface ModelWatchlistResult {
  name: string;
  items: WatchedSymbol[];
}

export class ListWatchlist {
  constructor(private readonly models: readonly ModelWatchlist[]) {}

  execute(): Promise<ModelWatchlistResult[]> {
    return Promise.all(
      this.models.map(async (m) => ({
        name: m.name,
        items: await m.repository.list(),
      })),
    );
  }
}
