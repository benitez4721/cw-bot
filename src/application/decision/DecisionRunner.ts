import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { OrderConfig } from '../../domain/decision/DecisionTypes.js';
import type { MarketHours } from '../../domain/market/MarketHours.js';
import type { MetricsPort } from '../../domain/metrics/MetricsPort.js';
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
  broker: BrokerPort;
  marketHours: MarketHours;
  metrics: MetricsPort;
  orderConfig: OrderConfig;
  intervalMs: number;
  enabled?: boolean;
}

export class DecisionRunner {
  private readonly evaluate: EvaluateDecision;
  private readonly placeBracketOrder: PlaceBracketOrder;
  private readonly recordTradeContext: RecordTradeContext;
  private readonly watchlist: WatchlistRepository;
  private readonly broker: BrokerPort;
  private readonly marketHours: MarketHours;
  private readonly metrics: MetricsPort;
  private readonly orderConfig: OrderConfig;
  private readonly intervalMs: number;
  private readonly enabled: boolean;
  private readonly inFlight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private status: DecisionRunnerStatus;
  private lastIsOpen: boolean | null = null;
  private lastSuccessfulTick = 0;

  constructor(options: DecisionRunnerOptions) {
    this.evaluate = options.evaluate;
    this.placeBracketOrder = options.placeBracketOrder;
    this.recordTradeContext = options.recordTradeContext;
    this.watchlist = options.watchlist;
    this.broker = options.broker;
    this.marketHours = options.marketHours;
    this.metrics = options.metrics;
    this.orderConfig = options.orderConfig;
    this.intervalMs = options.intervalMs;
    this.enabled = options.enabled ?? true;
    this.status = this.enabled ? 'idle' : 'disabled';
  }

  start(): void {
    if (!this.enabled) {
      log.info('disabled by config — skipping loop');
      return;
    }
    if (this.timer) return;
    this.status = 'running';
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    log.info({ intervalMs: this.intervalMs }, 'started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.enabled) this.status = 'idle';
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
    if (this.inFlight.has(symbol)) {
      log.debug({ symbol }, 'still in-flight — skipping tick');
      return;
    }
    this.inFlight.add(symbol);
    try {
      if (await this.hasOpenExposure(symbol)) {
        return;
      }
      const signal = await this.evaluate.execute({ symbol });
      this.metrics.recordDecision(symbol, signal.action);
      if (signal.action !== 'buy') return;

      const placedAt = new Date().toISOString();
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
            placedAt,
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

  private async hasOpenExposure(symbol: string): Promise<boolean> {
    const [positions, orders] = await Promise.all([
      this.broker.getPositions(),
      this.broker.getOrders({ symbol }),
    ]);

    if (positions.some((p) => p.symbol === symbol && p.quantity !== 0))
      return true;
    return orders.some(
      (o) =>
        o.symbol === symbol &&
        (o.status === 'open' ||
          o.status === 'pending' ||
          o.status === 'partiallyFilled'),
    );
  }
}
