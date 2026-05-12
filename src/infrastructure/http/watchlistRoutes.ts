import type { FastifyPluginAsync } from 'fastify';
import type { ListWatchlist } from '../../application/watchlist/ListWatchlist.js';

interface WatchlistRoutesOptions {
  listWatchlist: ListWatchlist;
}

export const watchlistRoutes: FastifyPluginAsync<
  WatchlistRoutesOptions
> = async (server, opts) => {
  server.get('/api/watchlist', async () => {
    const results = await opts.listWatchlist.execute();
    const models = results.map((r) => ({
      name: r.name,
      items: r.items,
      count: r.items.length,
    }));
    const count = models.reduce((acc, m) => acc + m.count, 0);
    return { models, count };
  });
};
