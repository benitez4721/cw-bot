import type { FastifyPluginAsync } from 'fastify';
import type { ListWatchlist } from '../../application/watchlist/ListWatchlist.js';

interface WatchlistRoutesOptions {
  listWatchlist: ListWatchlist;
}

export const watchlistRoutes: FastifyPluginAsync<
  WatchlistRoutesOptions
> = async (server, opts) => {
  server.get('/api/watchlist', async () => {
    const items = await opts.listWatchlist.execute();
    return { items, count: items.length };
  });
};
