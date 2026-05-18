import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrokerPort } from '../../../domain/broker/BrokerPort.js';
import type { BracketOrderResult } from '../../../domain/broker/BrokerTypes.js';
import type { DecisionModel } from '../../../domain/decision/DecisionModel.js';
import type { DecisionStrategy } from '../../../domain/decision/DecisionStrategy.js';
import type { DecisionSignal } from '../../../domain/decision/DecisionTypes.js';
import type { MacdM1CrossOverSnapshot } from '../../../domain/decision/models/MacdM1CrossOverDecisionModel.js';
import type { MarketHours } from '../../../domain/market/MarketHours.js';
import type { BarRepository } from '../../../domain/marketdata/BarRepository.js';
import type {
  Bar,
  BarInterval,
} from '../../../domain/marketdata/MarketDataTypes.js';
import type {
  BarHandler,
  ConnectionHandler,
  MarketFeedPort,
} from '../../../domain/marketdata/MarketFeedPort.js';
import type { HistoricalBarsPort } from '../../../domain/marketdata/HistoricalBarsPort.js';
import type { MetricsPort } from '../../../domain/metrics/MetricsPort.js';
import type { TradeContextRepository } from '../../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../../domain/trade/TradeTypes.js';
import type { WatchlistRepository } from '../../../domain/watchlist/WatchlistRepository.js';
import type { WatchedSymbol } from '../../../domain/watchlist/WatchlistTypes.js';
import type { PlaceBracketOrder } from '../../broker/PlaceBracketOrder.js';
import { CloseTrade } from '../../trade/CloseTrade.js';
import { CheckOpenTrades } from '../../trade/CheckOpenTrades.js';
import type { RecordTradeContext } from '../../trade/RecordTradeContext.js';
import { BarStreamManager } from '../../marketdata/BarStreamManager.js';

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

function makeBuySignal(
  symbol = 'AAPL',
  overrides: {
    quantity?: number;
    stopOffset?: number;
    takeProfitOffset?: number;
  } = {},
): DecisionSignal<MacdM1CrossOverSnapshot> {
  const snapshot: MacdM1CrossOverSnapshot = {
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
    quantity: overrides.quantity ?? 100,
    stopOffset: overrides.stopOffset ?? 0.2,
    takeProfitOffset: overrides.takeProfitOffset ?? 0.35,
    checks: [],
    snapshot,
  };
}

function makeHoldSignal(
  symbol = 'AAPL',
): DecisionSignal<MacdM1CrossOverSnapshot> {
  const snapshot: MacdM1CrossOverSnapshot = {
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

type FakeTradeRepo = TradeContextRepository & {
  _seedActive: (ctx: TradeContext) => void;
  _items: Map<string, TradeContext>;
};

function createTradeRepo(): FakeTradeRepo {
  const items = new Map<string, TradeContext>();
  const active = new Map<string, Set<string>>();

  const activeKey = (model: string, symbol: string) => `${model}:${symbol}`;
  const ensureActiveSet = (key: string): Set<string> => {
    let set = active.get(key);
    if (!set) {
      set = new Set<string>();
      active.set(key, set);
    }
    return set;
  };

  return {
    async put(ctx: TradeContext) {
      items.set(ctx.bracket.entryOrderId, ctx);
      const key = activeKey(ctx.model, ctx.symbol);
      const set = ensureActiveSet(key);
      if (ctx.status === 'closed') {
        set.delete(ctx.bracket.entryOrderId);
      } else {
        set.add(ctx.bracket.entryOrderId);
      }
    },
    async getByOrderId(id: string) {
      return items.get(id);
    },
    async getByOrderIds(ids: string[]) {
      const out = new Map<string, TradeContext>();
      for (const id of ids) {
        const ctx = items.get(id);
        if (ctx) out.set(id, ctx);
      }
      return out;
    },
    async listActiveByModelAndSymbol(model, symbol) {
      const key = activeKey(model, symbol);
      const ids = active.get(key);
      if (!ids) return [];
      const out: TradeContext[] = [];
      for (const id of ids) {
        const ctx = items.get(id);
        if (ctx) out.push(ctx);
      }
      return out;
    },
    async listAllActive() {
      const out: TradeContext[] = [];
      for (const ctx of items.values()) {
        if (ctx.status === 'active') out.push(ctx);
      }
      return out;
    },
    _seedActive(ctx) {
      items.set(ctx.bracket.entryOrderId, ctx);
      const key = activeKey(ctx.model, ctx.symbol);
      ensureActiveSet(key).add(ctx.bracket.entryOrderId);
    },
    _items: items,
  };
}

interface StrategyFixture {
  name: string;
  initial?: WatchedSymbol[];
  evaluateImpl?: () => Promise<DecisionSignal<MacdM1CrossOverSnapshot>>;
}

interface MockModel extends DecisionModel<MacdM1CrossOverSnapshot> {
  buildSnapshot: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
}

interface StrategyHandle {
  name: string;
  watchlist: TestWatchlist;
  model: MockModel;
}

interface Setup {
  manager: BarStreamManager;
  feed: FakeFeed;
  barRepo: BarRepository;
  fetchHistorical: ReturnType<typeof vi.fn>;
  placeBracket: { execute: ReturnType<typeof vi.fn> };
  recordContext: { execute: ReturnType<typeof vi.fn> };
  tradeRepo: FakeTradeRepo;
  broker: BrokerPort;
  metrics: MetricsPort;
  marketOpen: { value: boolean };
  strategies: StrategyHandle[];
  // Convenience accessors for the first strategy (single-strategy tests).
  watchlist: TestWatchlist;
  model: MockModel;
}

function setup(
  opts: { initial?: WatchedSymbol[]; strategies?: StrategyFixture[] } = {},
): Setup {
  const fixtures: StrategyFixture[] = opts.strategies ?? [
    { name: 'MacdM1CrossOver', initial: opts.initial ?? [] },
  ];

  const feed = createFakeFeed();
  const barRepo = createInMemoryBarRepo();
  const fetchHistorical = vi.fn(
    async ({ interval }: { symbol: string; interval: BarInterval }) => {
      const stepMs = interval === '1min' ? 60_000 : 5 * 60_000;
      const lastClosed = Math.floor(Date.now() / stepMs) * stepMs - stepMs;
      return Array.from({ length: 5 }, (_, i) =>
        bar(new Date(lastClosed - (4 - i) * stepMs).toISOString(), 100 + i),
      );
    },
  );
  const historicalBars: HistoricalBarsPort = {
    fetchHistoricalBars: fetchHistorical,
  };

  const placeBracket = {
    execute: vi.fn(
      async (input: { symbol: string }): Promise<BracketOrderResult> => ({
        status: 'open',
        entryOrderId: `entry-${input.symbol}`,
        stopOrderId: `stop-${input.symbol}`,
        takeProfitOrderId: `tp-${input.symbol}`,
      }),
    ),
  };
  const recordContext = { execute: vi.fn(async () => undefined) };
  const tradeRepo = createTradeRepo();

  const broker: BrokerPort = {
    placeBracketOrder: vi.fn(),
    getPositions: vi.fn(async () => []),
    getOrders: vi.fn(async () => []),
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
  } as unknown as MetricsPort;

  const handles: StrategyHandle[] = fixtures.map((f) => {
    const watchlist = createWatchlist(f.initial ?? []);
    const evaluateImpl = f.evaluateImpl ?? (async () => makeHoldSignal());
    const model: MockModel = {
      name: f.name,
      buildSnapshot: vi.fn(async () => (await evaluateImpl()).snapshot),
      evaluate: vi.fn((snapshot: MacdM1CrossOverSnapshot) => {
        // Return either the live signal stub configured per test, or a hold
        // built from the snapshot the model itself just produced.
        return { action: 'hold', checks: [], snapshot } satisfies ReturnType<
          DecisionModel<MacdM1CrossOverSnapshot>['evaluate']
        >;
      }),
    };
    return {
      name: f.name,
      watchlist,
      model,
    };
  });

  const strategies: DecisionStrategy[] = handles.map((h) => ({
    name: h.name,
    model: h.model,
    watchlist: h.watchlist,
  }));

  const closeTrade = new CloseTrade(tradeRepo);
  const checkOpenTrades = new CheckOpenTrades({
    tradeRepo,
    broker,
    closeTrade,
  });

  const manager = new BarStreamManager({
    feed,
    historicalBars,
    barRepo,
    strategies,
    placeBracketOrder: placeBracket as unknown as PlaceBracketOrder,
    recordTradeContext: recordContext as unknown as RecordTradeContext,
    checkOpenTrades,
    marketHours,
    metrics,
    bootstrapBars: 5,
    syncIntervalMs: 60_000,
  });

  return {
    manager,
    feed,
    barRepo,
    fetchHistorical,
    placeBracket,
    recordContext,
    tradeRepo,
    broker,
    metrics,
    marketOpen,
    strategies: handles,
    watchlist: handles[0].watchlist,
    model: handles[0].model,
  };
}

// Helper for tests: makes a model fixture return the given signal on its
// next `evaluate` call (and on any subsequent ones).
function stubSignal(
  model: MockModel,
  signal: DecisionSignal<MacdM1CrossOverSnapshot>,
): void {
  model.buildSnapshot.mockResolvedValue(signal.snapshot);
  model.evaluate.mockReturnValue(signal);
}

function makeActiveContext(
  model: string,
  symbol: string,
  entryOrderId: string,
): TradeContext {
  return {
    model,
    symbol,
    side: 'BUY',
    entryLimitPrice: 100,
    evalStart: 't',
    evalEnd: 't',
    bracket: {
      entryOrderId,
      stopOrderId: `${entryOrderId}-stop`,
      takeProfitOrderId: `${entryOrderId}-tp`,
    },
    indicators: null,
    checks: [],
    status: 'active',
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
    expect(s.fetchHistorical).toHaveBeenCalledTimes(4);
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
    expect(s.model.evaluate).not.toHaveBeenCalled();
    s.manager.stop();
  });

  it('appends a non-:04 1m bar without touching the 5m series', async () => {
    const s = setup({
      initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
    });
    await s.manager.start();
    const before5 = (await s.barRepo.get('AAPL', '5min')).length;
    await s.feed.emitBar('AAPL', bar('2026-05-07T13:35:00.000Z', 105));
    expect((await s.barRepo.get('AAPL', '5min')).length).toBe(before5);
    expect(s.model.evaluate).toHaveBeenCalledOnce();
    s.manager.stop();
  });

  it('appends a 5m bar when a :04 minute closes a bucket', async () => {
    const s = setup({
      initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
    });
    await s.manager.start();
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
    expect(s.model.evaluate).not.toHaveBeenCalled();
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
    expect(s.fetchHistorical).toHaveBeenCalledTimes(2);
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

  it('skips placing an order when the model already has open exposure', async () => {
    const s = setup({
      initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
    });
    s.tradeRepo._seedActive(
      makeActiveContext('MacdM1CrossOver', 'AAPL', 'entry-1'),
    );
    (s.broker.getOrders as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'entry-1',
        symbol: 'AAPL',
        quantity: 100,
        side: 'BUY',
        type: 'Limit',
        status: 'open',
        createdAt: 't',
      },
    ]);
    stubSignal(s.model, makeBuySignal('AAPL'));
    await s.manager.start();
    await s.feed.emitBar('AAPL', bar('2026-05-07T13:35:00.000Z', 105));
    expect(s.model.evaluate).not.toHaveBeenCalled();
    expect(s.placeBracket.execute).not.toHaveBeenCalled();
    s.manager.stop();
  });

  it('marks the trade context closed when no bracket order is still active', async () => {
    const s = setup({
      initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
    });
    s.tradeRepo._seedActive(
      makeActiveContext('MacdM1CrossOver', 'AAPL', 'entry-1'),
    );
    // Broker reports no active orders for AAPL — the bracket is fully done.
    (s.broker.getOrders as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    stubSignal(s.model, makeHoldSignal('AAPL'));
    await s.manager.start();
    await s.feed.emitBar('AAPL', bar('2026-05-07T13:35:00.000Z', 105));
    expect(s.tradeRepo._items.get('entry-1')?.status).toBe('closed');
    expect(
      await s.tradeRepo.listActiveByModelAndSymbol('MacdM1CrossOver', 'AAPL'),
    ).toHaveLength(0);
    expect(s.model.evaluate).toHaveBeenCalledOnce();
    s.manager.stop();
  });

  it('places a bracket order on a buy signal and records context tagged with the model', async () => {
    const s = setup({
      initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
    });
    stubSignal(s.model, makeBuySignal('AAPL'));
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
    const recordArgs = s.recordContext.execute.mock.calls[0][0];
    expect(recordArgs).toMatchObject({
      model: 'MacdM1CrossOver',
      bracket: {
        entryOrderId: 'entry-AAPL',
        stopOrderId: 'stop-AAPL',
        takeProfitOrderId: 'tp-AAPL',
      },
    });
    s.manager.stop();
  });

  it('does not place an order on a hold signal', async () => {
    const s = setup({
      initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
    });
    await s.manager.start();
    await s.feed.emitBar('AAPL', bar('2026-05-07T13:35:00.000Z', 105));
    expect(s.model.evaluate).toHaveBeenCalledOnce();
    expect(s.placeBracket.execute).not.toHaveBeenCalled();
    s.manager.stop();
  });

  it('drops the in-progress bucket from the bootstrap (1min and 5min)', async () => {
    const nowMs = Date.UTC(2026, 4, 7, 13, 38, 0);
    const s = setup({
      initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
    });
    s.fetchHistorical.mockImplementation(
      async ({ interval }: { symbol: string; interval: BarInterval }) => {
        if (interval === '1min') {
          return [
            bar('2026-05-07T13:35:00.000Z', 100),
            bar('2026-05-07T13:36:00.000Z', 101),
            bar('2026-05-07T13:37:00.000Z', 102),
            bar('2026-05-07T13:38:00.000Z', 103),
          ];
        }
        return [
          bar('2026-05-07T13:25:00.000Z', 100),
          bar('2026-05-07T13:30:00.000Z', 101),
          bar('2026-05-07T13:35:00.000Z', 102),
        ];
      },
    );
    const manager = new BarStreamManager({
      feed: s.feed,
      historicalBars: { fetchHistoricalBars: s.fetchHistorical },
      barRepo: s.barRepo,
      strategies: [
        {
          name: 'MacdM1CrossOver',
          model: s.model,
          watchlist: s.watchlist,
        },
      ],
      placeBracketOrder: s.placeBracket as unknown as PlaceBracketOrder,
      recordTradeContext: s.recordContext as unknown as RecordTradeContext,
      checkOpenTrades: new CheckOpenTrades({
        tradeRepo: s.tradeRepo,
        broker: s.broker,
        closeTrade: new CloseTrade(s.tradeRepo),
      }),
      marketHours: { isOpen: () => true },
      metrics: s.metrics,
      bootstrapBars: 5,
      syncIntervalMs: 60_000,
      now: () => nowMs,
    });
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

  it('unsubscribes and clears cache when a symbol disappears from every watchlist', async () => {
    const s = setup({
      initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
    });
    await s.manager.start();
    expect(s.feed.subscribed.has('AAPL')).toBe(true);
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

  // ---- multi-strategy ----

  it('with two strategies sharing AAPL, both evaluate and place independent bracket orders', async () => {
    const s = setup({
      strategies: [
        {
          name: 'MacdM1CrossOver',
          initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
        },
        {
          name: 'meanRev',
          initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
        },
      ],
    });
    stubSignal(s.strategies[0].model, makeBuySignal('AAPL'));
    stubSignal(
      s.strategies[1].model,
      makeBuySignal('AAPL', {
        quantity: 50,
        stopOffset: 0.5,
        takeProfitOffset: 1.0,
      }),
    );
    await s.manager.start();
    await s.feed.emitBar('AAPL', bar('2026-05-07T13:35:00.000Z', 105));
    expect(s.placeBracket.execute).toHaveBeenCalledTimes(2);
    expect(s.placeBracket.execute.mock.calls[0][0]).toMatchObject({
      quantity: 100,
      stopOffset: 0.2,
    });
    expect(s.placeBracket.execute.mock.calls[1][0]).toMatchObject({
      quantity: 50,
      stopOffset: 0.5,
    });
    expect(s.recordContext.execute).toHaveBeenCalledTimes(2);
    const models = s.recordContext.execute.mock.calls.map(
      (c: unknown[]) => (c[0] as { model: string }).model,
    );
    expect(models).toEqual(['MacdM1CrossOver', 'meanRev']);
    s.manager.stop();
  });

  it('only evaluates a strategy whose watchlist contains the symbol', async () => {
    const s = setup({
      strategies: [
        {
          name: 'MacdM1CrossOver',
          initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
        },
        {
          name: 'meanRev',
          initial: [{ symbol: 'MSFT', status: 'active', createdAt: 1 }],
        },
      ],
    });
    stubSignal(s.strategies[0].model, makeBuySignal('AAPL'));
    stubSignal(s.strategies[1].model, makeBuySignal('AAPL'));
    await s.manager.start();
    await s.feed.emitBar('AAPL', bar('2026-05-07T13:35:00.000Z', 105));
    expect(s.strategies[0].model.evaluate).toHaveBeenCalledOnce();
    expect(s.strategies[1].model.evaluate).not.toHaveBeenCalled();
    expect(s.placeBracket.execute).toHaveBeenCalledOnce();
    s.manager.stop();
  });

  it('exposure is tracked per model: A blocked, B places its own order on the same symbol', async () => {
    const s = setup({
      strategies: [
        {
          name: 'MacdM1CrossOver',
          initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
        },
        {
          name: 'meanRev',
          initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
        },
      ],
    });
    s.tradeRepo._seedActive(
      makeActiveContext('MacdM1CrossOver', 'AAPL', 'entry-tech'),
    );
    (s.broker.getOrders as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        id: 'entry-tech',
        symbol: 'AAPL',
        quantity: 100,
        side: 'BUY',
        type: 'Limit',
        status: 'open',
        createdAt: 't',
      },
    ]);
    stubSignal(s.strategies[0].model, makeBuySignal('AAPL'));
    stubSignal(s.strategies[1].model, makeBuySignal('AAPL'));
    await s.manager.start();
    await s.feed.emitBar('AAPL', bar('2026-05-07T13:35:00.000Z', 105));
    expect(s.strategies[0].model.evaluate).not.toHaveBeenCalled();
    expect(s.strategies[1].model.evaluate).toHaveBeenCalledOnce();
    expect(s.placeBracket.execute).toHaveBeenCalledOnce();
    expect(s.recordContext.execute.mock.calls[0][0]).toMatchObject({
      model: 'meanRev',
    });
    s.manager.stop();
  });

  it('keeps a symbol subscribed when it disappears from one watchlist but not the other', async () => {
    const s = setup({
      strategies: [
        {
          name: 'MacdM1CrossOver',
          initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
        },
        {
          name: 'meanRev',
          initial: [{ symbol: 'AAPL', status: 'active', createdAt: 1 }],
        },
      ],
    });
    await s.manager.start();
    expect(s.feed.subscribed.has('AAPL')).toBe(true);
    s.strategies[0].watchlist._remove('AAPL');
    await s.manager.forceSync();
    // Still wanted by meanRev → stays subscribed.
    expect(s.feed.subscribed.has('AAPL')).toBe(true);
    s.strategies[1].watchlist._remove('AAPL');
    await s.manager.forceSync();
    // Now nobody wants it.
    expect(s.feed.subscribed.has('AAPL')).toBe(false);
    s.manager.stop();
  });
});
