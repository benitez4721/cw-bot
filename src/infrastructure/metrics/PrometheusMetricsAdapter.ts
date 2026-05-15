import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import type {
  DecisionAction,
  MetricsPort,
  OauthRefreshResult,
  OrderRecordStatus,
  TickOutcome,
  TsErrorType,
  TsOperation,
} from '../../domain/metrics/MetricsPort.js';

export class PrometheusMetricsAdapter implements MetricsPort {
  readonly registry: Registry;
  private readonly decisions: Counter<'symbol' | 'action'>;
  private readonly ticks: Counter<'outcome'>;
  private readonly orders: Counter<'status'>;
  private readonly tsRequestDuration: Histogram<'operation'>;
  private readonly tsErrors: Counter<'type'>;
  private readonly oauthRefresh: Counter<'result'>;
  private readonly watchlistSize: Gauge;
  private readonly scannerConnected: Gauge;
  private readonly barsReceived: Counter;
  private readonly barDedupSkips: Counter;
  private readonly bootstrapFailures: Counter;
  private readonly marketFeedConnected: Gauge;

  constructor() {
    this.registry = new Registry();
    this.registry.setDefaultLabels({ app: 'cw-bot' });
    collectDefaultMetrics({ register: this.registry });

    this.decisions = new Counter({
      name: 'decisions_total',
      help: 'Total decision evaluations by symbol and action',
      labelNames: ['symbol', 'action'],
      registers: [this.registry],
    });
    this.ticks = new Counter({
      name: 'decision_runner_ticks_total',
      help: 'BarStreamManager ticks by outcome',
      labelNames: ['outcome'],
      registers: [this.registry],
    });
    this.orders = new Counter({
      name: 'orders_total',
      help: 'Orders placed by status',
      labelNames: ['status'],
      registers: [this.registry],
    });
    this.tsRequestDuration = new Histogram({
      name: 'tradestation_request_duration_ms',
      help: 'TradeStation HTTP request latency in milliseconds',
      buckets: [50, 100, 250, 500, 1000, 2500, 5000, 10000],
      labelNames: ['operation'],
      registers: [this.registry],
    });
    this.tsErrors = new Counter({
      name: 'tradestation_errors_total',
      help: 'TradeStation errors by type',
      labelNames: ['type'],
      registers: [this.registry],
    });
    this.oauthRefresh = new Counter({
      name: 'oauth_refresh_total',
      help: 'TradeStation OAuth refresh outcomes',
      labelNames: ['result'],
      registers: [this.registry],
    });
    this.watchlistSize = new Gauge({
      name: 'watchlist_size',
      help: 'Current watchlist size',
      registers: [this.registry],
    });
    this.scannerConnected = new Gauge({
      name: 'scanner_ws_connected',
      help: 'ChartWatcher WebSocket state (0 disconnected / 1 connected)',
      registers: [this.registry],
    });
    this.barsReceived = new Counter({
      name: 'bars_received_total',
      help: 'Realtime AM bars received from the market feed',
      registers: [this.registry],
    });
    this.barDedupSkips = new Counter({
      name: 'bar_dedup_skips_total',
      help: 'Bars skipped because their timestamp matched the last cached one',
      registers: [this.registry],
    });
    this.bootstrapFailures = new Counter({
      name: 'bootstrap_failures_total',
      help: 'Symbol bootstraps that failed (Twelve Data fetchHistoricalBars)',
      registers: [this.registry],
    });
    this.marketFeedConnected = new Gauge({
      name: 'market_feed_ws_connected',
      help: 'Polygon WebSocket state (0 disconnected / 1 connected)',
      registers: [this.registry],
    });
  }

  recordDecision(symbol: string, action: DecisionAction): void {
    this.decisions.inc({ symbol, action });
  }

  recordTick(outcome: TickOutcome): void {
    this.ticks.inc({ outcome });
  }

  recordOrderResult(status: OrderRecordStatus): void {
    this.orders.inc({ status });
  }

  recordTsRequest(
    durationMs: number,
    operation: TsOperation,
    errorType?: TsErrorType,
  ): void {
    this.tsRequestDuration.observe({ operation }, durationMs);
    if (errorType) this.tsErrors.inc({ type: errorType });
  }

  recordOauthRefresh(result: OauthRefreshResult): void {
    this.oauthRefresh.inc({ result });
  }

  setWatchlistSize(size: number): void {
    this.watchlistSize.set(size);
  }

  setScannerConnected(connected: boolean): void {
    this.scannerConnected.set(connected ? 1 : 0);
  }

  recordBarReceived(): void {
    this.barsReceived.inc();
  }

  recordBarDedupSkip(): void {
    this.barDedupSkips.inc();
  }

  recordBootstrapFailure(): void {
    this.bootstrapFailures.inc();
  }

  setMarketFeedConnected(connected: boolean): void {
    this.marketFeedConnected.set(connected ? 1 : 0);
  }
}
