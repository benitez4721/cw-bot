import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { OrderResult } from '../../domain/broker/BrokerTypes.js';
import type { DecisionSignal } from '../../domain/decision/DecisionTypes.js';
import type { TechnicalSnapshot } from '../../infrastructure/decision/TechnicalDecisionModelAdapter.js';
import type { MarketHours } from '../../domain/market/MarketHours.js';
import type { BarRepository } from '../../domain/marketdata/BarRepository.js';
import type {
  Bar,
  BarInterval,
} from '../../domain/marketdata/MarketDataTypes.js';
import type {
  BarHandler,
  ConnectionHandler,
  MarketFeedPort,
} from '../../domain/marketdata/MarketFeedPort.js';
import type { HistoricalBarsPort } from '../../domain/marketdata/HistoricalBarsPort.js';
import type { MetricsPort } from '../../domain/metrics/MetricsPort.js';
import type { WatchlistRepository } from '../../domain/watchlist/WatchlistRepository.js';
import type { WatchedSymbol } from '../../domain/watchlist/WatchlistTypes.js';
import type { EvaluateDecision } from '../decision/EvaluateDecision.js';
import type { PlaceBracketOrder } from '../broker/PlaceBracketOrder.js';
import type { RecordTradeContext } from '../trade/RecordTradeContext.js';
import { BarStreamManager } from './BarStreamManager.js';

function bar(timestampUtc: string, close = 100, volume = 1000): Bar {
  return {
    timestamp: timestampUtc,
    open: close,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume,
  };
}

function makeBuySignal(symbol = 'AAPL'): DecisionSignal<TechnicalSnapshot> {
  const snapshot: TechnicalSnapshot = {
    symbol,
    quote: { symbol, last: 100, bid: 99.9, ask: 100.1, timestamp: 't' },
    macd5min: { macd: 0.1, signal: 0.05, histogram: 0.05, timestamp: 't' },
    macd1minSeries: [
      { macd: 0.1, signal: 0.05, histogram: 0.05, timestamp: 't1' },
      { macd: 0.05, signal: 0.04, histogram: -0.01, timestamp: 't0' },
    ],
    vwap1min: { value: 99, timestamp: 't' },
  };
  return {
    action: 'buy',
    symbol,
    side: 'BUY',
    entryLimitPrice: 100.05,
    checks: [],
    snapshot,
  };
}

function makeHoldSignal(symbol = 'AAPL'): DecisionSignal<TechnicalSnapshot> {
  const snapshot: TechnicalSnapshot = {
    symbol,
    quote: { symbol, last: 100, bid: 99.9, ask: 100.1, timestamp: 't' },
    macd5min: { macd: 0, signal: 0, histogram: 0, timestamp: 't' },
    macd1minSeries: [
      { macd: 0, signal: 0, histogram: 0, timestamp: 't1' },
      { macd: 0, signal: 0, histogram: 0, timestamp: 't0' },
    ],
    vwap1min: { value: 99, timestamp: 't' },
  };
  return { action: 'hold', checks: [], snapshot };
}

interface FakeFeed extends MarketFeedPort {
  emitBar(symbol: string, bar: Bar): Promise<void>;
  subscribed: Set<string>;
}

function createFakeFeed(): FakeFeed {
  let barHandler: BarHandler | null = null;
  let connHandler: ConnectionHandler | null = null;
  const subscribed = new Set<string>();
  const handlers: { onBar: BarHandler[] } = { onBar: [] };
  return {
    subscribed,
    async connect() {
      connHandler?.(true);
    },
    disconnect() {
      // Emulate real adapter: closing the WS drops the server-side
      // subscription set.
      subscribed.clear();
      connHandler?.(false);
    },
    subscribe(symbol) {
      subscribed.add(symbol);
    },
    unsubscribe(symbol) {
      subscribed.delete(symbol);
    },
    onBar(handler) {
      barHandler = handler;
      handlers.onBar.push(handler);
    },
    onConnectionChange(handler) {
      connHandler = handler;
    },
    async emitBar(symbol, bar) {
      if (!barHandler) throw new Error('no bar handler registered');
      barHandler(symbol, bar);
      // Yield so the manager's awaited handleBar settles.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
  };
}

function createInMemoryBarRepo(): BarRepository {
  const data = new Map<string, { '1min': Bar[]; '5min': Bar[] }>();
  const ensure = (s: string) => {
    let entry = data.get(s);
    if (!entry) {
      entry = { '1min': [], '5min': [] };
      data.set(s, entry);
    }
    return entry;
  };
  return {
    async get(symbol, interval, limit) {
      const arr = data.get(symbol)?.[interval] ?? [];
      if (limit !== undefined && arr.length > limit) return arr.slice(-limit);
      return [...arr];
    },
    async set(symbol, interval, bars) {
      ensure(symbol)[interval] = [...bars];
    },
    async append(symbol, interval, b) {
      ensure(symbol)[interval].push(b);
    },
    async delete(symbol) {
      data.delete(symbol);
    },
  };
}

type TestWatchlist = WatchlistRepository & {
  _remove: (symbol: string) => void;
};

function createWatchlist(initial: WatchedSymbol[] = []): TestWatchlist {
  let items = [...initial];
  return {
    async put(s: WatchedSymbol) {
      const idx = items.findIndex((it) => it.symbol === s.symbol);
      if (idx >= 0) {
        items[idx] = s;
      } else {
        items.push(s);
      }
    },
    async getBySymbol(s: string) {
      return items.find((it) => it.symbol === s);
    },
    async list() {
      return [...items];
    },
    _remove(symbol: string) {
      items = items.filter((it) => it.symbol !== symbol);
    },
  };
}

interface Setup {
  manager: BarStreamManager;
  feed: FakeFeed;
  barRepo: BarRepository;
  watchlist: TestWatchlist;
  fetchHistorical: ReturnType<typeof vi.fn>;
  evaluate: { execute: ReturnType<typeof vi.fn> };
  placeBracket: { execute: ReturnType<typeof vi.fn> };
  recordContext: { execute: ReturnType<typeof vi.fn> };
  broker: BrokerPort;
  metrics: MetricsPort;
  marketOpen: { value: boolean };
}

function setup(opts: { initial?: WatchedSymbol[] } = {}): Setup {
  const feed = createFakeFeed();
  const barRepo = createInMemoryBarRepo();
  const watchlist = createWatchlist(opts.initial ?? []);
  const fetchHistorical = vi.fn(
    async ({ interval }: { symbol: string; interval: BarInterval }) => {
      // Default: 5 ascending bars ending well before "now" so the
      // dropOpenBucket filter keeps all of them.
      const stepMs = interval === '1min' ? 60_000 : 5 * 60_000;
      const lastClosed = Math.floor(Date.now() / stepMs) * stepMs - stepMs; // last fully-closed bucket
      return Array.from({ length: 5 }, (_, i) =>
        bar(new Date(lastClosed - (4 - i) * stepMs).toISOString(), 100 + i),
      );
    },
  );
  const historicalBars: HistoricalBarsPort = {
    fetchHistoricalBars: fetchHistorical,
  };

  const evaluate = { execute: vi.fn(async () => makeHoldSignal()) };
  const placeBracket = {
    execute: vi.fn(
      async (): Promise<OrderResult> => ({
        orderId: 'order-1',
        status: 'open',
      }),
    ),
  };
  const recordContext = { execute: vi.fn(async () => undefined) };

  const broker: BrokerPort = {
    placeOrder: vi.fn(),
    placeBracketOrder: vi.fn(),
    cancelOrder: vi.fn(),
    replaceOrder: vi.fn(),
    getBalances: vi.fn(),
    getPositions: vi.fn(async () => []),
    getOrders: vi.fn(async () => []),
    getHistoricalOrders: vi.fn(),
    getQuote: vi.fn(),
  } as unknown as BrokerPort;

  const marketOpen = { value: true };
  const marketHours: MarketHours = { isOpen: () => marketOpen.value };

  const metrics: MetricsPort = {
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
  };

  const manager = new BarStreamManager({
    feed,
    historicalBars,
    barRepo,
    watchlist,
    evaluate: evaluate as unknown as EvaluateDecision,
    placeBracketOrder: placeBracket as unknown as PlaceBracketOrder,
    recordTradeContext: recordContext as unknown as RecordTradeContext,
    broker,
    marketHours,
    metrics,
    orderConfig: { quantity: 100, stopOffset: 0.2, takeProfitOffset: 0.35 },
    bootstrapBars: 5,
    syncIntervalMs: 60_000, // long enough that tests don't trigger a second sync
  });

  return {
    manager,
    feed,
    barRepo,
    watchlist,
    fetchHistorical,
    evaluate,
    placeBracket,
    recordContext,
    broker,
    metrics,
    marketOpen,
  };
}

describe('BarStreamManager', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('start() bootstraps every watchlist symbol (active and stale) and subscribes them', async () => {
    const s = setup({
      initial: [
        { symbol: 'AAPL', status: 'active', createdAt: 1 },
        { symbol: 'TSLA', status: 'stale', createdAt: 2 },
      ],
    });
    await s.manager.start();
    expect(s.fetchHistorical).toHaveBeenCalledTimes(4); // 1m + 5m × 2 symbols
    expect(s.feed.subscribed.has('AAPL')).toBe(true);
    expect(s.feed.subscribed.has('TSLA')).toBe(true);
    expect((await s.barRepo.get('AAPL', '1min')).length).toBe(5);
    expect((await s.barRepo.get('TSLA', '5min')).length).toBe(5);
    s.manager.stop();
  });

  it('dedupes a bar whose timestamp matches the last cached 1m bar', async () => {
    const s = setup({
      initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
    });
    await s.manager.start();
    const last = (await s.barRepo.get('AAPL', '1min')).at(-1)!;
    const before = (await s.barRepo.get('AAPL', '1min')).length;
    await s.feed.emitBar('AAPL', { ...last });
    expect((await s.barRepo.get('AAPL', '1min')).length).toBe(before);
    expect(s.evaluate.execute).not.toHaveBeenCalled();
    s.manager.stop();
  });

  it('appends a non-:04 1m bar without touching the 5m series', async () => {
    const s = setup({
      initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
    });
    await s.manager.start();
    const before5 = (await s.barRepo.get('AAPL', '5min')).length;
    // minute :35 → 35 % 5 === 0 → does NOT close a bucket
    await s.feed.emitBar('AAPL', bar('2026-05-07T13:35:00.000Z', 105));
    expect((await s.barRepo.get('AAPL', '5min')).length).toBe(before5);
    expect(s.evaluate.execute).toHaveBeenCalledOnce();
    s.manager.stop();
  });

  it('appends a 5m bar when a :04 minute closes a bucket', async () => {
    const s = setup({
      initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
    });
    await s.manager.start();
    // Replace 1m cache with bars at :30, :31, :32, :33 so the next emit (:34)
    // closes the 5m bucket starting at :30.
    const startMs = Date.UTC(2026, 4, 7, 13, 30);
    const seed = [0, 1, 2, 3].map((i) =>
      bar(new Date(startMs + i * 60_000).toISOString(), 100 + i, 1000),
    );
    await s.barRepo.set('AAPL', '1min', seed);
    const before5 = (await s.barRepo.get('AAPL', '5min')).length;
    await s.feed.emitBar('AAPL', bar('2026-05-07T13:34:00.000Z', 104, 1000));
    const after5 = await s.barRepo.get('AAPL', '5min');
    expect(after5.length).toBe(before5 + 1);
    expect(after5.at(-1)!.timestamp).toBe('2026-05-07T13:30:00.000Z');
    expect(after5.at(-1)!.open).toBe(100);
    expect(after5.at(-1)!.close).toBe(104);
    expect(after5.at(-1)!.volume).toBe(5000);
    s.manager.stop();
  });

  it('does not connect the feed nor bootstrap when market is closed', async () => {
    const s = setup({
      initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
    });
    s.marketOpen.value = false;
    await s.manager.start();
    expect(s.fetchHistorical).not.toHaveBeenCalled();
    expect(s.feed.subscribed.has('AAPL')).toBe(false);
    expect(s.evaluate.execute).not.toHaveBeenCalled();
    s.manager.stop();
  });

  it('connects and bootstraps when market opens on a later tick', async () => {
    const s = setup({
      initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
    });
    s.marketOpen.value = false;
    await s.manager.start();
    expect(s.feed.subscribed.has('AAPL')).toBe(false);
    s.marketOpen.value = true;
    await s.manager.forceSync();
    expect(s.fetchHistorical).toHaveBeenCalledTimes(2); // 1m + 5m for AAPL
    expect(s.feed.subscribed.has('AAPL')).toBe(true);
    s.manager.stop();
  });

  it('disconnects feed and drops subscriptions when market closes', async () => {
    const s = setup({
      initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
    });
    await s.manager.start();
    expect(s.feed.subscribed.has('AAPL')).toBe(true);
    s.marketOpen.value = false;
    await s.manager.forceSync();
    expect(s.feed.subscribed.has('AAPL')).toBe(false);
    s.manager.stop();
  });

  it('skips placing an order when symbol has open exposure', async () => {
    const s = setup({
      initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
    });
    (s.broker.getPositions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { symbol: 'AAPL', quantity: 100, avgPrice: 100 },
    ]);
    s.evaluate.execute.mockResolvedValue(makeBuySignal('AAPL'));
    await s.manager.start();
    await s.feed.emitBar('AAPL', bar('2026-05-07T13:35:00.000Z', 105));
    expect(s.evaluate.execute).not.toHaveBeenCalled();
    expect(s.placeBracket.execute).not.toHaveBeenCalled();
    s.manager.stop();
  });

  it('places a bracket order on a buy signal and records context', async () => {
    const s = setup({
      initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
    });
    s.evaluate.execute.mockResolvedValue(makeBuySignal('AAPL'));
    await s.manager.start();
    await s.feed.emitBar('AAPL', bar('2026-05-07T13:35:00.000Z', 105));
    expect(s.placeBracket.execute).toHaveBeenCalledOnce();
    const placeArgs = s.placeBracket.execute.mock.calls[0][0];
    expect(placeArgs).toMatchObject({
      symbol: 'AAPL',
      side: 'BUY',
      entryLimitPrice: 100.05,
      quantity: 100,
      stopOffset: 0.2,
      takeProfitOffset: 0.35,
    });
    expect(s.recordContext.execute).toHaveBeenCalledOnce();
    s.manager.stop();
  });

  it('does not place an order on a hold signal', async () => {
    const s = setup({
      initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
    });
    await s.manager.start();
    await s.feed.emitBar('AAPL', bar('2026-05-07T13:35:00.000Z', 105));
    expect(s.evaluate.execute).toHaveBeenCalledOnce();
    expect(s.placeBracket.execute).not.toHaveBeenCalled();
    s.manager.stop();
  });

  it('drops the in-progress bucket from the bootstrap (1min and 5min)', async () => {
    // Wall clock pinned at 13:38:00 (mid-period for the 5m bucket that opened
    // at 13:35, and just past the close of the 1m bucket that opened at 13:37).
    const nowMs = Date.UTC(2026, 4, 7, 13, 38, 0);
    const s = setup({
      initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
    });
    // Replace setup()'s manager with one whose now() is pinned for deterministic
    // gating against fixed-timestamp Twelve Data fixtures.
    const manager = new BarStreamManager({
      feed: s.feed,
      historicalBars: { fetchHistoricalBars: s.fetchHistorical },
      barRepo: s.barRepo,
      watchlist: s.watchlist,
      evaluate: s.evaluate as unknown as EvaluateDecision,
      placeBracketOrder: s.placeBracket as unknown as PlaceBracketOrder,
      recordTradeContext: s.recordContext as unknown as RecordTradeContext,
      broker: s.broker,
      marketHours: { isOpen: () => true },
      metrics: s.metrics,
      orderConfig: { quantity: 100, stopOffset: 0.2, takeProfitOffset: 0.35 },
      bootstrapBars: 5,
      syncIntervalMs: 60_000,
      now: () => nowMs,
    });
    s.fetchHistorical.mockImplementation(
      async ({ interval }: { symbol: string; interval: BarInterval }) => {
        if (interval === '1min') {
          // bars at 13:35..13:38 — the 13:38 bar (closes 13:39) is partial at now=13:38:00
          return [
            bar('2026-05-07T13:35:00.000Z', 100),
            bar('2026-05-07T13:36:00.000Z', 101),
            bar('2026-05-07T13:37:00.000Z', 102),
            bar('2026-05-07T13:38:00.000Z', 103), // partial
          ];
        }
        // 5min: 13:25, 13:30, 13:35 — the 13:35 bucket (closes 13:40) is partial
        return [
          bar('2026-05-07T13:25:00.000Z', 100),
          bar('2026-05-07T13:30:00.000Z', 101),
          bar('2026-05-07T13:35:00.000Z', 102), // partial
        ];
      },
    );
    await manager.start();
    const cached1m = await s.barRepo.get('AAPL', '1min');
    const cached5m = await s.barRepo.get('AAPL', '5min');
    expect(cached1m.map((b) => b.timestamp)).toEqual([
      '2026-05-07T13:35:00.000Z',
      '2026-05-07T13:36:00.000Z',
      '2026-05-07T13:37:00.000Z',
    ]);
    expect(cached5m.map((b) => b.timestamp)).toEqual([
      '2026-05-07T13:25:00.000Z',
      '2026-05-07T13:30:00.000Z',
    ]);
    manager.stop();
  });

  it('continues subscribing the next sync if bootstrap fails', async () => {
    const s = setup({
      initial: [{ symbol: 'BAD', status: 'active', createdAt: 1 }],
    });
    s.fetchHistorical.mockRejectedValueOnce(new Error('twelve data 429'));
    await s.manager.start();
    expect(s.feed.subscribed.has('BAD')).toBe(false);
    s.manager.stop();
  });

  it('unsubscribes and clears cache when a symbol disappears from the watchlist', async () => {
    const s = setup({
      initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
    });
    await s.manager.start();
    expect(s.feed.subscribed.has('AAPL')).toBe(true);
    // Symbol fully removed from the watchlist (e.g. TTL expired in Redis).
    s.watchlist._remove('AAPL');
    await s.manager.forceSync();
    expect(s.feed.subscribed.has('AAPL')).toBe(false);
    expect((await s.barRepo.get('AAPL', '1min')).length).toBe(0);
    s.manager.stop();
  });

  it('keeps a symbol monitored when it transitions from active to stale', async () => {
    const s = setup({
      initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
    });
    await s.manager.start();
    expect(s.feed.subscribed.has('AAPL')).toBe(true);
    await s.watchlist.put({ symbol: 'AAPL', status: 'stale', createdAt: 1 });
    await s.manager.forceSync();
    expect(s.feed.subscribed.has('AAPL')).toBe(true);
    expect((await s.barRepo.get('AAPL', '1min')).length).toBeGreaterThan(0);
    s.manager.stop();
  });
});
