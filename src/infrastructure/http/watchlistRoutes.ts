import type { FastifyInstance } from 'fastify';
import type { ScannerMonitor } from '../../application/watchlist/ScannerMonitor.js';
import type { WatchlistRepository } from '../../domain/watchlist/WatchlistRepository.js';
import type { WatchedSymbol, WatchedSymbolStatus } from '../../domain/watchlist/WatchlistTypes.js';

const VALID_STATUSES: WatchedSymbolStatus[] = ['active', 'stale'];

interface ListQuery {
  status?: string;
}

function serialize(s: WatchedSymbol) {
  return {
    symbol: s.symbol,
    status: s.status,
    createdAt: s.createdAt,
  };
}

export function registerWatchlistRoutes({
  server,
  repository,
  monitor,
}: {
  server: FastifyInstance;
  repository: WatchlistRepository;
  monitor: ScannerMonitor;
}) {
  server.get<{ Querystring: ListQuery }>('/api/watchlist', async (request, reply) => {
    const { status } = request.query;

    if (status !== undefined && !VALID_STATUSES.includes(status as WatchedSymbolStatus)) {
      return reply
        .status(400)
        .send({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
    }

    let items = repository.list();
    if (status) items = items.filter((s) => s.status === status);

    return { count: items.length, items: items.map(serialize) };
  });

  server.get<{ Params: { symbol: string } }>('/api/watchlist/:symbol', async (request, reply) => {
    const watched = repository.getBySymbol(request.params.symbol);
    if (!watched) {
      return reply.status(404).send({ error: 'symbol not in watchlist' });
    }
    return serialize(watched);
  });

  server.get('/api/watchlist/scanner', async () => ({
    status: monitor.getStatus(),
    configId: monitor.getConfigId(),
  }));
}
