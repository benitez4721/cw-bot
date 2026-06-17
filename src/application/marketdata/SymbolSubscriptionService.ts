import type { DecisionStrategy } from '../../domain/decision/DecisionStrategy.js';
import type { BarRepository } from '../../domain/marketdata/BarRepository.js';
import type { HistoricalBarsPort } from '../../domain/marketdata/HistoricalBarsPort.js';
import type { Bar } from '../../domain/marketdata/MarketDataTypes.js';
import type { MarketFeedPort } from '../../domain/marketdata/MarketFeedPort.js';
import type { MetricsPort } from '../../domain/metrics/MetricsPort.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import { aggregateOneFiveMinuteBucket } from '../../domain/indicators/calculations.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { errMsg } from '../../shared/errors.js';

const log = logger.child({ component: 'SymbolSubscriptionService' });

const DEFAULT_BOOTSTRAP_BARS = 200;

export interface SymbolSubscriptionServiceOptions {
  feed: MarketFeedPort;
  historicalBars: HistoricalBarsPort;
  barRepo: BarRepository;
  strategies: DecisionStrategy[];
  metrics: MetricsPort;
  // Trade repo: ademas de las watchlists de las DecisionStrategy, los simbolos
  // de los trades activos (EventStrategy incluidos) se suman al set suscrito
  // para que el manager reciba sus barras.
  tradeRepo?: TradeContextRepository;
  bootstrapBars?: number;
  now?: () => number;
}

// Mantiene el set de simbolos suscritos al feed y su cache de barras 1m/5m
// fresca. El BarStreamManager delega aca el sync de watchlist (polling de la
// union de watchlists + trades activos), el bootstrap/recovery de cache y la
// ingesta de cada barra del feed.
export class SymbolSubscriptionService {
  private readonly feed: MarketFeedPort;
  private readonly historicalBars: HistoricalBarsPort;
  private readonly barRepo: BarRepository;
  private readonly strategies: DecisionStrategy[];
  private readonly metrics: MetricsPort;
  private readonly tradeRepo?: TradeContextRepository;
  private readonly bootstrapBars: number;
  private readonly now: () => number;

  private readonly subscribed = new Set<string>();
  // Dedup: ensure at most one in-flight cache recovery per symbol.
  private readonly recoveryInFlight = new Set<string>();

  constructor(options: SymbolSubscriptionServiceOptions) {
    this.feed = options.feed;
    this.historicalBars = options.historicalBars;
    this.barRepo = options.barRepo;
    this.strategies = options.strategies;
    this.metrics = options.metrics;
    this.tradeRepo = options.tradeRepo;
    this.bootstrapBars = options.bootstrapBars ?? DEFAULT_BOOTSTRAP_BARS;
    this.now = options.now ?? (() => Date.now());
  }

  subscribedCount(): number {
    return this.subscribed.size;
  }

  clear(): void {
    this.subscribed.clear();
  }

  async syncWatchlist(): Promise<void> {
    const wanted = await this.unionWatchlist();

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

  // Ingesta una barra del feed: dedup contra la ultima 1m cacheada, append
  // 1m y (en el cierre del bucket) agregacion 5m. Devuelve true si la barra
  // es nueva y el simbolo esta suscrito — la señal para que el manager corra
  // las estrategias sobre ella.
  async ingestBar(symbol: string, bar: Bar): Promise<boolean> {
    const cached1m = await this.barRepo.get(symbol, '1min');
    const lastTs = cached1m[cached1m.length - 1]?.timestamp;
    if (lastTs === bar.timestamp) {
      this.metrics.recordBarDedupSkip();
      log.debug({ symbol, ts: bar.timestamp }, 'dedupe skip');
      return false;
    }

    this.metrics.recordBarReceived();
    await this.barRepo.append(symbol, '1min', bar);

    const minute = new Date(bar.timestamp).getUTCMinutes();
    if (minute % 5 === 4) {
      await this.maybeAppendFiveMinute(symbol);
    }

    return this.subscribed.has(symbol);
  }

  // Triggered when the indicator port reports the cache is missing/short.
  // Skips the WS subscribe step if the symbol is already subscribed.
  async recoverCache(symbol: string): Promise<void> {
    if (this.recoveryInFlight.has(symbol)) return;
    this.recoveryInFlight.add(symbol);
    try {
      log.warn({ symbol }, 'cache underfilled — re-bootstrapping');
      if (this.subscribed.has(symbol)) {
        await this.refreshHistoricalCache(symbol);
      } else {
        await this.bootstrapAndSubscribe(symbol);
      }
    } catch (err) {
      log.error({ symbol, err: errMsg(err) }, 'cache recovery failed');
    } finally {
      this.recoveryInFlight.delete(symbol);
    }
  }

  private async unionWatchlist(): Promise<Set<string>> {
    const lists = await Promise.all(
      this.strategies.map((s) => s.watchlist.list()),
    );
    const wanted = new Set<string>();
    for (const list of lists) {
      for (const item of list) wanted.add(item.symbol);
    }
    // Suma simbolos de trades activos (EventStrategy incluidos). Garantiza que
    // el manager siga recibiendo barras del simbolo mientras dure el trade,
    // incluso si ninguna DecisionStrategy lo tiene en su watchlist.
    if (this.tradeRepo) {
      try {
        const active = await this.tradeRepo.listAllActive();
        for (const ctx of active) wanted.add(ctx.symbol);
      } catch (err) {
        log.warn(
          { err: errMsg(err) },
          'listAllActive failed in unionWatchlist — using strategy lists only',
        );
      }
    }
    return wanted;
  }

  private async bootstrapAndSubscribe(symbol: string): Promise<void> {
    // El bootstrap historico es best-effort: si falla (p.ej. TwelveData no sirve
    // 5min en pre — "Pre/post data is available only for 1min interval"), igual
    // suscribimos al feed. Los stops sinteticos (CheckSyntheticStops /
    // MaybeRepegSyntheticExit / MaybeTrailSyntheticStop) operan sobre el
    // TradeContext + las barras live + el quote, NO sobre el cache, asi que una
    // posicion abierta queda protegida aunque no haya historico. Las
    // DecisionStrategy si necesitan el cache: disparan CacheUnderfilledError y
    // reintentan el bootstrap via recoverCache.
    try {
      await this.refreshHistoricalCache(symbol);
    } catch (err) {
      this.metrics.recordBootstrapFailure();
      log.warn(
        { symbol, err: errMsg(err) },
        'historical bootstrap failed — subscribing anyway (stops use live bars + ctx)',
      );
    }
    this.feed.subscribe(symbol);
    this.subscribed.add(symbol);
  }

  // Repopulates the 1m/5m cache for a symbol from the historical-bars port.
  // Idempotent: callers (initial bootstrap + cache recovery) share this path.
  private async refreshHistoricalCache(symbol: string): Promise<void> {
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
    const now = this.now();
    const closed1m = dropOpenBucket(bars1m, 60_000, now);
    const closed5m = dropOpenBucket(bars5m, 5 * 60_000, now);
    await Promise.all([
      this.barRepo.set(symbol, '1min', closed1m),
      this.barRepo.set(symbol, '5min', closed5m),
    ]);
    log.info(
      {
        symbol,
        bars1m: closed1m.length,
        bars5m: closed5m.length,
        dropped1m: bars1m.length - closed1m.length,
        dropped5m: bars5m.length - closed5m.length,
      },
      'historical cache refreshed',
    );
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
}

function dropOpenBucket(bars: Bar[], bucketMs: number, nowMs: number): Bar[] {
  return bars.filter((b) => {
    const closeMs = new Date(b.timestamp).getTime() + bucketMs;
    return closeMs <= nowMs;
  });
}
