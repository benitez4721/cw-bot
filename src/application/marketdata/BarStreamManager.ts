import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { OrderConfig } from '../../domain/decision/DecisionTypes.js';
import type { MarketHours } from '../../domain/market/MarketHours.js';
import type { BarRepository } from '../../domain/marketdata/BarRepository.js';
import type { HistoricalBarsPort } from '../../domain/marketdata/HistoricalBarsPort.js';
import type { Bar } from '../../domain/marketdata/MarketDataTypes.js';
import type { MarketFeedPort } from '../../domain/marketdata/MarketFeedPort.js';
import type { MetricsPort } from '../../domain/metrics/MetricsPort.js';
import type { WatchlistRepository } from '../../domain/watchlist/WatchlistRepository.js';
import { aggregateOneFiveMinuteBucket } from '../../infrastructure/indicators/calculations.js';
import { logger } from '../../infrastructure/logging/logger.js';
import type { PlaceBracketOrder } from '../broker/PlaceBracketOrder.js';
import type { EvaluateDecision } from '../decision/EvaluateDecision.js';
import type { RecordTradeContext } from '../trade/RecordTradeContext.js';

const log = logger.child({ component: 'BarStreamManager' });

const DEFAULT_BOOTSTRAP_BARS = 200;
const DEFAULT_SYNC_INTERVAL_MS = 10_000;

export type BarStreamManagerStatus = 'idle' | 'running';

export interface BarStreamManagerOptions {
  feed: MarketFeedPort;
  historicalBars: HistoricalBarsPort;
  barRepo: BarRepository;
  watchlist: WatchlistRepository;
  evaluate: EvaluateDecision;
  placeBracketOrder: PlaceBracketOrder;
  recordTradeContext: RecordTradeContext;
  broker: BrokerPort;
  marketHours: MarketHours;
  metrics: MetricsPort;
  orderConfig: OrderConfig;
  bootstrapBars?: number;
  syncIntervalMs?: number;
  // Injected for tests
  now?: () => number;
  schedule?: (cb: () => void, ms: number) => NodeJS.Timeout;
  cancel?: (handle: NodeJS.Timeout) => void;
}

// Event-driven runtime: subscribes to the realtime feed, keeps the bar cache
// fresh, and triggers EvaluateDecision on each AM bar close. Symbols are
// added/removed by polling the watchlist on a fixed interval.
export class BarStreamManager {
  private readonly feed: MarketFeedPort;
  private readonly historicalBars: HistoricalBarsPort;
  private readonly barRepo: BarRepository;
  private readonly watchlist: WatchlistRepository;
  private readonly evaluate: EvaluateDecision;
  private readonly placeBracketOrder: PlaceBracketOrder;
  private readonly recordTradeContext: RecordTradeContext;
  private readonly broker: BrokerPort;
  private readonly marketHours: MarketHours;
  private readonly metrics: MetricsPort;
  private readonly orderConfig: OrderConfig;
  private readonly bootstrapBars: number;
  private readonly syncIntervalMs: number;
  private readonly now: () => number;
  private readonly schedule: (cb: () => void, ms: number) => NodeJS.Timeout;
  private readonly cancel: (handle: NodeJS.Timeout) => void;

  private readonly subscribed = new Set<string>();
  private readonly inFlight = new Set<string>();
  private tickTimer: NodeJS.Timeout | null = null;
  private status: BarStreamManagerStatus = 'idle';
  private handlersRegistered = false;
  private lastSuccessfulTick = 0;
  private feedConnected = false;

  constructor(options: BarStreamManagerOptions) {
    this.feed = options.feed;
    this.historicalBars = options.historicalBars;
    this.barRepo = options.barRepo;
    this.watchlist = options.watchlist;
    this.evaluate = options.evaluate;
    this.placeBracketOrder = options.placeBracketOrder;
    this.recordTradeContext = options.recordTradeContext;
    this.broker = options.broker;
    this.marketHours = options.marketHours;
    this.metrics = options.metrics;
    this.orderConfig = options.orderConfig;
    this.bootstrapBars = options.bootstrapBars ?? DEFAULT_BOOTSTRAP_BARS;
    this.syncIntervalMs = options.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? ((cb, ms) => setTimeout(cb, ms));
    this.cancel = options.cancel ?? ((h) => clearTimeout(h));
  }

  getStatus(): BarStreamManagerStatus {
    return this.status;
  }

  lastSuccessfulTickAt(): number {
    return this.lastSuccessfulTick;
  }

  subscribedCount(): number {
    return this.subscribed.size;
  }

  // Public hook that forces an immediate tick without waiting for the timer.
  // Useful for tests and ad-hoc reconciliation. Goes through full tick
  // logic (market-hours gating + watchlist sync), not just the watchlist diff.
  async forceSync(): Promise<void> {
    return this.tick();
  }

  async start(): Promise<void> {
    if (this.status === 'running') return;

    if (!this.handlersRegistered) {
      this.feed.onBar((symbol, bar) => {
        void this.handleBar(symbol, bar).catch((err) => {
          log.error(
            { symbol, err: errMsg(err) },
            'handleBar failed unexpectedly',
          );
        });
      });
      this.feed.onConnectionChange((connected) => {
        log.info({ connected }, 'feed connection');
        this.metrics.setMarketFeedConnected(connected);
      });
      this.handlersRegistered = true;
    }

    this.status = 'running';
    // First tick is synchronous — connects the feed and bootstraps if the
    // market is already open, or just waits otherwise.
    await this.tick();
    this.scheduleNextTick();
    log.info(
      {
        subscribed: this.subscribed.size,
        marketOpen: this.feedConnected,
      },
      'started',
    );
  }

  stop(): void {
    if (this.status === 'idle') return;
    this.status = 'idle';
    if (this.tickTimer) {
      this.cancel(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.feedConnected) {
      this.feed.disconnect();
      this.feedConnected = false;
    }
    // Clear local trackers so a subsequent start() rebuilds subscriptions
    // from the watchlist (the feed lost its session on disconnect).
    this.subscribed.clear();
    this.inFlight.clear();
  }

  private scheduleNextTick(): void {
    if (this.status !== 'running') return;
    this.tickTimer = this.schedule(() => {
      this.tickTimer = null;
      void this.tick()
        .catch((err) => {
          log.error({ err: errMsg(err) }, 'tick failed');
        })
        .finally(() => this.scheduleNextTick());
    }, this.syncIntervalMs);
  }

  // Coordinates market-hours gating with feed lifecycle. Called on every
  // periodic tick (and once synchronously during start()).
  //
  // - market open + feed not connected → connect feed + sync watchlist
  // - market open + feed connected     → sync watchlist
  // - market closed + feed connected   → disconnect feed + drop subscriptions
  // - market closed + feed not connected → idle (just keep ticking)
  private async tick(): Promise<void> {
    const open = this.marketHours.isOpen(new Date(this.now()));

    if (open && !this.feedConnected) {
      log.info('market open — connecting feed');
      try {
        await this.feed.connect();
        this.feedConnected = true;
      } catch (err) {
        log.error(
          { err: errMsg(err) },
          'feed connect failed — will retry on next tick',
        );
        return;
      }
      await this.syncWatchlist();
      return;
    }

    if (!open && this.feedConnected) {
      log.info('market closed — disconnecting feed');
      this.feed.disconnect();
      this.feedConnected = false;
      this.subscribed.clear();
      this.inFlight.clear();
      return;
    }

    if (open && this.feedConnected) {
      await this.syncWatchlist();
    }
    // !open && !feedConnected: nothing to do until market opens
  }

  private async syncWatchlist(): Promise<void> {
    const items = await this.watchlist.list();
    const wanted = new Set(items.map((i) => i.symbol));

    for (const symbol of wanted) {
      if (this.subscribed.has(symbol)) continue;
      try {
        await this.bootstrapAndSubscribe(symbol);
      } catch (err) {
        this.metrics.recordBootstrapFailure();
        log.error(
          { symbol, err: errMsg(err) },
          'bootstrap failed — will retry on next sync',
        );
      }
    }

    for (const symbol of [...this.subscribed]) {
      if (wanted.has(symbol)) continue;
      this.feed.unsubscribe(symbol);
      this.subscribed.delete(symbol);
      try {
        await this.barRepo.delete(symbol);
      } catch (err) {
        log.warn({ symbol, err: errMsg(err) }, 'cache delete failed');
      }
    }
  }

  private async bootstrapAndSubscribe(symbol: string): Promise<void> {
    log.info({ symbol, bars: this.bootstrapBars }, 'bootstrapping');
    const [bars1m, bars5m] = await Promise.all([
      this.historicalBars.fetchHistoricalBars({
        symbol,
        interval: '1min',
        limit: this.bootstrapBars,
      }),
      this.historicalBars.fetchHistoricalBars({
        symbol,
        interval: '5min',
        limit: this.bootstrapBars,
      }),
    ]);
    // Twelve Data returns the bucket in progress with partial values when the
    // query lands mid-period. Drop it — only buckets whose period has fully
    // elapsed are safe to use; anything else biases MACD/EMA against an
    // incomplete close. The realtime WS will fill it in once it actually
    // closes (Polygon AM emits closed bars only).
    const now = this.now();
    const closed1m = dropOpenBucket(bars1m, 60_000, now);
    const closed5m = dropOpenBucket(bars5m, 5 * 60_000, now);
    await Promise.all([
      this.barRepo.set(symbol, '1min', closed1m),
      this.barRepo.set(symbol, '5min', closed5m),
    ]);
    this.feed.subscribe(symbol);
    this.subscribed.add(symbol);
    log.info(
      {
        symbol,
        bars1m: closed1m.length,
        bars5m: closed5m.length,
        dropped1m: bars1m.length - closed1m.length,
        dropped5m: bars5m.length - closed5m.length,
      },
      'bootstrapped + subscribed',
    );
  }

  private async handleBar(symbol: string, bar: Bar): Promise<void> {
    // Polygon may resend a corrected AM for the same minute — dedupe by
    // timestamp against the last cached 1m bar to avoid double-appending.
    const cached1m = await this.barRepo.get(symbol, '1min');
    const lastTs = cached1m[cached1m.length - 1]?.timestamp;
    if (lastTs === bar.timestamp) {
      this.metrics.recordBarDedupSkip();
      log.debug({ symbol, ts: bar.timestamp }, 'dedupe skip');
      return;
    }

    this.metrics.recordBarReceived();
    await this.barRepo.append(symbol, '1min', bar);

    // A 1m bar with minute === :04, :09, :14, ... closes a 5m bucket.
    const minute = new Date(bar.timestamp).getUTCMinutes();
    if (minute % 5 === 4) {
      await this.maybeAppendFiveMinute(symbol);
    }

    if (!this.subscribed.has(symbol)) return;
    await this.processSymbol(symbol);
    this.lastSuccessfulTick = this.now();
  }

  private async maybeAppendFiveMinute(symbol: string): Promise<void> {
    const last5 = await this.barRepo.get(symbol, '1min', 5);
    if (last5.length !== 5) {
      log.warn(
        { symbol, count: last5.length },
        'bucket close but <5 1m bars cached, skipping 5m append',
      );
      return;
    }
    try {
      const bar5m = aggregateOneFiveMinuteBucket(last5);
      await this.barRepo.append(symbol, '5min', bar5m);
      log.debug({ symbol, ts: bar5m.timestamp }, '5m bucket closed');
    } catch (err) {
      log.warn({ symbol, err: errMsg(err) }, '5m aggregation failed');
    }
  }

  private async processSymbol(symbol: string): Promise<void> {
    if (this.inFlight.has(symbol)) {
      log.debug({ symbol }, 'in-flight skip');
      return;
    }
    this.inFlight.add(symbol);

    const evalStart = new Date(this.now()).toISOString();
    try {
      if (!this.marketHours.isOpen(new Date(this.now()))) return;
      if (await this.hasOpenExposure(symbol)) return;

      const signal = await this.evaluate.execute({ symbol });
      const evalEnd = new Date(this.now()).toISOString();

      this.metrics.recordDecision(symbol, signal.action);
      if (signal.action !== 'buy') return;

      const result = await this.placeBracketOrder.execute({
        symbol: signal.symbol,
        side: signal.side,
        entryLimitPrice: signal.entryLimitPrice,
        ...this.orderConfig,
      });
      this.metrics.recordOrderResult(result.status);
      log.info(
        { symbol, orderId: result.orderId, status: result.status },
        'bracket placed',
      );

      if (
        result.orderId &&
        result.status !== 'rejected' &&
        result.status !== 'cancelled' &&
        result.status !== 'expired'
      ) {
        try {
          await this.recordTradeContext.execute({
            orderId: result.orderId,
            signal,
            evalStart,
            evalEnd,
          });
        } catch (err) {
          log.warn(
            { symbol, orderId: result.orderId, err: errMsg(err) },
            'failed to persist trade context',
          );
        }
      }
    } catch (err) {
      log.error({ symbol, err: errMsg(err) }, 'process failed');
    } finally {
      this.inFlight.delete(symbol);
    }
  }

  private async hasOpenExposure(symbol: string): Promise<boolean> {
    const [positions, orders] = await Promise.all([
      this.broker.getPositions(),
      this.broker.getOrders({ symbol }),
    ]);
    if (positions.some((p) => p.symbol === symbol && p.quantity !== 0)) {
      return true;
    }
    return orders.some(
      (o) =>
        o.symbol === symbol &&
        (o.status === 'open' ||
          o.status === 'pending' ||
          o.status === 'partiallyFilled'),
    );
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function dropOpenBucket(bars: Bar[], bucketMs: number, nowMs: number): Bar[] {
  return bars.filter((b) => {
    const closeMs = new Date(b.timestamp).getTime() + bucketMs;
    return closeMs <= nowMs;
  });
}
