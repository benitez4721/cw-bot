import type { OrderConfig } from '../../domain/decision/DecisionTypes.js';
import type { MarketHours } from '../../domain/market/MarketHours.js';
import type { MetricsPort } from '../../domain/metrics/MetricsPort.js';
import type { TradedSymbolsRepository } from '../../domain/trade/TradedSymbolsRepository.js';
import type { WatchlistRepository } from '../../domain/watchlist/WatchlistRepository.js';
import { logger } from '../../infrastructure/logging/logger.js';
import type { EvaluateDecision } from './EvaluateDecision.js';
import type { PlaceBracketOrder } from '../broker/PlaceBracketOrder.js';
import type { RecordTradeContext } from '../trade/RecordTradeContext.js';

const log = logger.child({ component: 'DecisionRunner' });

export type DecisionRunnerStatus = 'idle' | 'running' | 'disabled';

export interface DecisionRunnerOptions {
  evaluate: EvaluateDecision;
  placeBracketOrder: PlaceBracketOrder;
  recordTradeContext: RecordTradeContext;
  watchlist: WatchlistRepository;
  tradedSymbols: TradedSymbolsRepository;
  marketHours: MarketHours;
  metrics: MetricsPort;
  orderConfig: OrderConfig;
  enabled?: boolean;
  // Injected for tests; defaults to Date.now / global setTimeout.
  now?: () => number;
  schedule?: (cb: () => void, ms: number) => NodeJS.Timeout;
  cancel?: (handle: NodeJS.Timeout) => void;
}

const MINUTE_MS = 60_000;
// Wait this long past each minute boundary before firing the tick. Twelve Data
// publishes the just-closed 1m bar with variable lag (observed 10s–70s after
// close), so firing too early reads a stale snapshot. :20 trades a bit of
// latency for a much higher chance the indicator endpoints have caught up.
const TICK_OFFSET_MS = 20_000;

export class DecisionRunner {
  private readonly evaluate: EvaluateDecision;
  private readonly placeBracketOrder: PlaceBracketOrder;
  private readonly recordTradeContext: RecordTradeContext;
  private readonly watchlist: WatchlistRepository;
  private readonly tradedSymbols: TradedSymbolsRepository;
  private readonly marketHours: MarketHours;
  private readonly metrics: MetricsPort;
  private readonly orderConfig: OrderConfig;
  private readonly enabled: boolean;
  private readonly now: () => number;
  private readonly schedule: (cb: () => void, ms: number) => NodeJS.Timeout;
  private readonly cancel: (handle: NodeJS.Timeout) => void;
  private readonly inFlight = new Set<string>();
  private readonly lastBarTs = new Map<string, string>();
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private status: DecisionRunnerStatus;
  private lastIsOpen: boolean | null = null;
  private lastSuccessfulTick = 0;

  constructor(options: DecisionRunnerOptions) {
    this.evaluate = options.evaluate;
    this.placeBracketOrder = options.placeBracketOrder;
    this.recordTradeContext = options.recordTradeContext;
    this.watchlist = options.watchlist;
    this.tradedSymbols = options.tradedSymbols;
    this.marketHours = options.marketHours;
    this.metrics = options.metrics;
    this.orderConfig = options.orderConfig;
    this.enabled = options.enabled ?? true;
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? ((cb, ms) => setTimeout(cb, ms));
    this.cancel = options.cancel ?? ((h) => clearTimeout(h));
    this.status = this.enabled ? 'idle' : 'disabled';
  }

  start(): void {
    if (!this.enabled) {
      log.info('disabled by config — skipping loop');
      return;
    }
    if (this.running) return;
    this.running = true;
    this.status = 'running';
    log.info('started');
    this.scheduleNext();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      this.cancel(this.timer);
      this.timer = null;
    }
    if (this.enabled) this.status = 'idle';
  }

  // Sleeps until the next HH:MM:OFFSET (offset past the minute boundary), then
  // runs tick(). Recomputed from wall-clock after each tick so a slow tick
  // doesn't drift and we transparently skip missed minutes (no stacked
  // back-to-back ticks).
  private scheduleNext(): void {
    if (!this.running) return;
    const now = this.now();
    const target =
      Math.floor((now - TICK_OFFSET_MS) / MINUTE_MS) * MINUTE_MS +
      MINUTE_MS +
      TICK_OFFSET_MS;
    const delay = Math.max(0, target - now);
    this.timer = this.schedule(() => {
      this.timer = null;
      void this.tick().finally(() => this.scheduleNext());
    }, delay);
  }

  getStatus(): DecisionRunnerStatus {
    return this.status;
  }

  lastSuccessfulTickAt(): number {
    return this.lastSuccessfulTick;
  }

  private async tick(): Promise<void> {
    try {
      const open = this.marketHours.isOpen(new Date());
      if (this.lastIsOpen !== open) {
        log.info({ open }, 'market hours transition');
        this.lastIsOpen = open;
      }
      if (!open) {
        this.metrics.recordTick('market_closed');
        return;
      }

      const items = await this.watchlist.list();
      const symbols = items.map((s) => s.symbol);

      if (symbols.length === 0) {
        this.metrics.recordTick('empty');
        this.lastSuccessfulTick = Date.now();
        return;
      }

      await Promise.all(symbols.map((symbol) => this.processSymbol(symbol)));
      this.metrics.recordTick('ok');
      this.lastSuccessfulTick = Date.now();
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'tick failed',
      );
    }
  }

  private async processSymbol(symbol: string): Promise<void> {
    const evalStart = new Date().toISOString();
    if (this.inFlight.has(symbol)) {
      log.debug({ symbol }, 'still in-flight — skipping tick');
      return;
    }
    this.inFlight.add(symbol);
    try {
      if (await this.tradedSymbols.has(symbol)) {
        return;
      }
      const signal = await this.evaluate.execute({ symbol });
      const evalEnd = new Date().toISOString();

      // If the 1m bar didn't advance since the previous tick, the REST feed
      // hasn't published the new bar yet — log it (so we can quantify how
      // often this happens) and skip to avoid acting on a stale signal.
      const currentBarTs = signal.snapshot.macd1minSeries[0]?.timestamp;
      if (currentBarTs && this.lastBarTs.get(symbol) === currentBarTs) {
        log.warn(
          { symbol, barTimestamp: currentBarTs },
          '1min bar unchanged since last tick — feed may be lagging, skipping',
        );
        return;
      }
      if (currentBarTs) this.lastBarTs.set(symbol, currentBarTs);

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
        await this.tradedSymbols.add(symbol);
        try {
          await this.recordTradeContext.execute({
            orderId: result.orderId,
            signal,
            evalStart,
            evalEnd,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          log.warn(
            { symbol, orderId: result.orderId, err: message },
            'failed to persist trade context',
          );
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      log.error({ symbol, err: message }, 'process failed');
    } finally {
      this.inFlight.delete(symbol);
    }
  }
}
