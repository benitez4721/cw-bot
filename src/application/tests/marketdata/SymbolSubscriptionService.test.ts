import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionStrategy } from '../../../domain/decision/DecisionStrategy.js';
import type { BarRepository } from '../../../domain/marketdata/BarRepository.js';
import type { Bar } from '../../../domain/marketdata/MarketDataTypes.js';
import type { HistoricalBarsPort } from '../../../domain/marketdata/HistoricalBarsPort.js';
import type { MarketFeedPort } from '../../../domain/marketdata/MarketFeedPort.js';
import type { MetricsPort } from '../../../domain/metrics/MetricsPort.js';
import type { TradeContextRepository } from '../../../domain/trade/TradeContextRepository.js';
import { SymbolSubscriptionService } from '../../marketdata/SymbolSubscriptionService.js';

// now fijo en ~2100 para que dropOpenBucket conserve las barras de prueba.
const NOW_MS = 4102444800000;

function bar(timestamp: string): Bar {
  return { timestamp, open: 1, high: 1, low: 1, close: 1, volume: 1 };
}

function makeMetrics(): MetricsPort & {
  recordBootstrapFailure: ReturnType<typeof vi.fn>;
  recordBarReceived: ReturnType<typeof vi.fn>;
  recordBarDedupSkip: ReturnType<typeof vi.fn>;
} {
  return {
    recordDecision: vi.fn(),
    recordTick: vi.fn(),
    recordOrderResult: vi.fn(),
    recordTsRequest: vi.fn(),
    recordOauthRefresh: vi.fn(),
    setWatchlistSize: vi.fn(),
    setScannerConnected: vi.fn(),
    recordBarReceived: vi.fn(),
    recordBarDedupSkip: vi.fn(),
    recordBootstrapFailure: vi.fn(),
    setMarketFeedConnected: vi.fn(),
    recordFlattenOutcome: vi.fn(),
    recordFlattenFailure: vi.fn(),
    recordAlertOutcome: vi.fn(),
  };
}

function strategyWithWatchlist(
  list: ReturnType<typeof vi.fn>,
): DecisionStrategy {
  return { watchlist: { list } } as unknown as DecisionStrategy;
}

function setup(opts: {
  watchlist: ReturnType<typeof vi.fn>;
  active?: { symbol: string }[];
  fetchThrows?: boolean;
}) {
  const feed = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    onBar: vi.fn(),
    onConnectionChange: vi.fn(),
  } as unknown as MarketFeedPort & {
    subscribe: ReturnType<typeof vi.fn>;
    unsubscribe: ReturnType<typeof vi.fn>;
  };

  const cached = new Map<string, Bar[]>();
  const barRepo = {
    get: vi.fn(async (symbol: string) => cached.get(symbol) ?? []),
    set: vi.fn(async (symbol: string, _i: string, bars: Bar[]) => {
      cached.set(symbol, bars);
    }),
    append: vi.fn(async (symbol: string, _i: string, b: Bar) => {
      cached.set(symbol, [...(cached.get(symbol) ?? []), b]);
    }),
    delete: vi.fn(async (symbol: string) => {
      cached.delete(symbol);
    }),
  } as unknown as BarRepository;

  const historicalBars = {
    fetchHistoricalBars: opts.fetchThrows
      ? vi.fn(async () => {
          throw new Error('rate limited');
        })
      : vi.fn(async () => [bar('2026-01-15T14:00:00Z')]),
  } as unknown as HistoricalBarsPort;

  const tradeRepo = {
    listAllActive: vi.fn(async () => opts.active ?? []),
  } as unknown as TradeContextRepository;

  const metrics = makeMetrics();
  const service = new SymbolSubscriptionService({
    feed,
    historicalBars,
    barRepo,
    strategies: [strategyWithWatchlist(opts.watchlist)],
    metrics,
    tradeRepo,
    now: () => NOW_MS,
  });

  return { service, feed, barRepo, historicalBars, tradeRepo, metrics };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SymbolSubscriptionService — syncWatchlist', () => {
  it('suscribe y bootstrapea los simbolos deseados', async () => {
    const f = setup({ watchlist: vi.fn(async () => [{ symbol: 'AAA' }]) });

    await f.service.syncWatchlist();

    expect(f.historicalBars.fetchHistoricalBars).toHaveBeenCalled();
    expect(f.feed.subscribe).toHaveBeenCalledWith('AAA');
    expect(f.service.subscribedCount()).toBe(1);
  });

  it('desuscribe y borra cache de los simbolos que ya no se quieren', async () => {
    const watchlist = vi
      .fn()
      .mockResolvedValueOnce([{ symbol: 'AAA' }, { symbol: 'BBB' }])
      .mockResolvedValueOnce([{ symbol: 'AAA' }]);
    const f = setup({ watchlist });

    await f.service.syncWatchlist();
    expect(f.service.subscribedCount()).toBe(2);

    await f.service.syncWatchlist();
    expect(f.feed.unsubscribe).toHaveBeenCalledWith('BBB');
    expect(f.barRepo.delete).toHaveBeenCalledWith('BBB');
    expect(f.service.subscribedCount()).toBe(1);
  });

  it('incluye los simbolos de trades activos del tradeRepo', async () => {
    const f = setup({
      watchlist: vi.fn(async () => []),
      active: [{ symbol: 'CCC' }],
    });

    await f.service.syncWatchlist();

    expect(f.feed.subscribe).toHaveBeenCalledWith('CCC');
    expect(f.service.subscribedCount()).toBe(1);
  });

  it('si el bootstrap falla, igual suscribe (best-effort) y registra la falla', async () => {
    // Desacople: los stops sinteticos no dependen del cache historico, asi que
    // suscribimos al feed aunque el bootstrap falle — la posicion queda
    // protegida con barras live + ctx.
    const f = setup({
      watchlist: vi.fn(async () => [{ symbol: 'AAA' }]),
      fetchThrows: true,
    });

    await f.service.syncWatchlist();

    expect(f.metrics.recordBootstrapFailure).toHaveBeenCalledOnce();
    expect(f.feed.subscribe).toHaveBeenCalledWith('AAA');
    expect(f.service.subscribedCount()).toBe(1);
  });
});

describe('SymbolSubscriptionService — ingestBar', () => {
  it('dedup: misma timestamp que la ultima 1m cacheada → false, sin append', async () => {
    const f = setup({ watchlist: vi.fn(async () => [{ symbol: 'AAA' }]) });
    await f.service.syncWatchlist();
    vi.clearAllMocks();

    // El bootstrap dejo la barra 2026-01-15T14:00:00Z cacheada.
    const result = await f.service.ingestBar(
      'AAA',
      bar('2026-01-15T14:00:00Z'),
    );

    expect(result).toBe(false);
    expect(f.metrics.recordBarDedupSkip).toHaveBeenCalledOnce();
    expect(f.barRepo.append).not.toHaveBeenCalled();
  });

  it('barra nueva en simbolo suscrito → appendea 1m y devuelve true', async () => {
    const f = setup({ watchlist: vi.fn(async () => [{ symbol: 'AAA' }]) });
    await f.service.syncWatchlist();

    const result = await f.service.ingestBar(
      'AAA',
      bar('2026-01-15T14:01:00Z'),
    );

    expect(result).toBe(true);
    expect(f.barRepo.append).toHaveBeenCalledWith(
      'AAA',
      '1min',
      expect.objectContaining({ timestamp: '2026-01-15T14:01:00Z' }),
    );
    expect(f.metrics.recordBarReceived).toHaveBeenCalledOnce();
  });

  it('barra nueva en simbolo NO suscrito → appendea pero devuelve false', async () => {
    const f = setup({ watchlist: vi.fn(async () => []) });

    const result = await f.service.ingestBar(
      'ZZZ',
      bar('2026-01-15T14:01:00Z'),
    );

    expect(result).toBe(false);
    expect(f.barRepo.append).toHaveBeenCalledOnce();
  });
});

describe('SymbolSubscriptionService — recoverCache', () => {
  it('si el simbolo no esta suscrito: bootstrapea y suscribe', async () => {
    const f = setup({ watchlist: vi.fn(async () => []) });

    await f.service.recoverCache('AAA');

    expect(f.feed.subscribe).toHaveBeenCalledWith('AAA');
    expect(f.service.subscribedCount()).toBe(1);
  });

  it('si el simbolo ya esta suscrito: solo refresca cache (no re-suscribe)', async () => {
    const f = setup({ watchlist: vi.fn(async () => [{ symbol: 'AAA' }]) });
    await f.service.syncWatchlist();
    vi.clearAllMocks();

    await f.service.recoverCache('AAA');

    expect(f.feed.subscribe).not.toHaveBeenCalled();
    expect(f.historicalBars.fetchHistoricalBars).toHaveBeenCalled();
  });
});
