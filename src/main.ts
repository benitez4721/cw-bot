import Redis from 'ioredis';
import { createServer } from './infrastructure/http/server.js';
import { env } from './infrastructure/config/env.js';
import { logger } from './infrastructure/logging/logger.js';
import { TradeStationBrokerAdapter } from './infrastructure/broker/TradeStationBrokerAdapter.js';
import { PlaceBracketOrder } from './application/broker/PlaceBracketOrder.js';
import { ChartsWatcherScannerFeedAdapter } from './infrastructure/scanner/ChartsWatcherScannerFeedAdapter.js';
import { InMemoryWatchlistRepository } from './infrastructure/watchlist/InMemoryWatchlistRepository.js';
import { RedisWatchlistRepository } from './infrastructure/watchlist/RedisWatchlistRepository.js';
import type { WatchlistRepository } from './domain/watchlist/WatchlistRepository.js';
import type { TradeContextRepository } from './domain/trade/TradeContextRepository.js';
import { InMemoryTradeContextRepository } from './infrastructure/trade/InMemoryTradeContextRepository.js';
import { RedisTradeContextRepository } from './infrastructure/trade/RedisTradeContextRepository.js';
import { RecordTradeContext } from './application/trade/RecordTradeContext.js';
import { ScannerMonitor } from './application/watchlist/ScannerMonitor.js';
import { ListWatchlist } from './application/watchlist/ListWatchlist.js';
import { GetOrders } from './application/broker/GetOrders.js';
import { watchlistRoutes } from './infrastructure/http/watchlistRoutes.js';
import { brokerRoutes } from './infrastructure/http/brokerRoutes.js';
import { healthRoutes } from './infrastructure/http/healthRoutes.js';
import { metricsRoutes } from './infrastructure/http/metricsRoutes.js';
import { registerAuthMiddleware } from './infrastructure/http/authMiddleware.js';
import type { IndicatorPort } from './domain/indicators/IndicatorPort.js';
import { AlphaVantageIndicatorAdapter } from './infrastructure/indicators/AlphaVantageIndicatorAdapter.js';
import { TwelveDataIndicatorAdapter } from './infrastructure/indicators/TwelveDataIndicatorAdapter.js';
import { TwelveDataHistoricalBarsAdapter } from './infrastructure/marketdata/TwelveDataHistoricalBarsAdapter.js';
import { TwelveDataClient } from './infrastructure/twelvedata/TwelveDataClient.js';
import { LocalIndicatorAdapter } from './infrastructure/indicators/LocalIndicatorAdapter.js';
import type { DecisionModelPort } from './domain/decision/DecisionPort.js';
import { TechnicalDecisionModelAdapter } from './infrastructure/decision/TechnicalDecisionModelAdapter.js';
import { EvaluateDecision } from './application/decision/EvaluateDecision.js';
import { DecisionRunner } from './application/decision/DecisionRunner.js';
import { BarStreamManager } from './application/marketdata/BarStreamManager.js';
import { RedisBarRepository } from './infrastructure/marketdata/RedisBarRepository.js';
import { PolygonMarketFeedAdapter } from './infrastructure/marketdata/PolygonMarketFeedAdapter.js';
import type { BarRepository } from './domain/marketdata/BarRepository.js';
import type { MarketFeedPort } from './domain/marketdata/MarketFeedPort.js';
import type { HistoricalBarsPort } from './domain/marketdata/HistoricalBarsPort.js';
import { UsMarketHoursAdapter } from './infrastructure/market/UsMarketHoursAdapter.js';
import { PrometheusMetricsAdapter } from './infrastructure/metrics/PrometheusMetricsAdapter.js';
import { GrafanaCloudWriter } from './infrastructure/metrics/GrafanaCloudWriter.js';
import { Heartbeat } from './application/heartbeat/Heartbeat.js';
import type { MetricsPort } from './domain/metrics/MetricsPort.js';

const log = logger.child({ component: 'main' });

function buildBroker(metrics: MetricsPort): TradeStationBrokerAdapter {
  switch (env.BROKER_PROVIDER) {
    case 'tradestation': {
      const missing: string[] = [];
      if (!env.TRADESTATION_CLIENT_ID) missing.push('TRADESTATION_CLIENT_ID');
      if (!env.TRADESTATION_REFRESH_TOKEN)
        missing.push('TRADESTATION_REFRESH_TOKEN');
      if (!env.TRADESTATION_ACCOUNT_ID) missing.push('TRADESTATION_ACCOUNT_ID');
      if (missing.length > 0) {
        throw new Error(
          `Missing required env vars for TradeStation: ${missing.join(', ')}`,
        );
      }
      return new TradeStationBrokerAdapter({
        clientId: env.TRADESTATION_CLIENT_ID!,
        clientSecret: env.TRADESTATION_CLIENT_SECRET || '',
        refreshToken: env.TRADESTATION_REFRESH_TOKEN!,
        accountId: env.TRADESTATION_ACCOUNT_ID!,
        simBaseUrl: env.TRADESTATION_SIM_URL,
        liveBaseUrl: env.TRADESTATION_LIVE_URL,
        signinUrl: env.TRADESTATION_SIGNIN_URL,
        metrics,
      });
    }
    default:
      throw new Error(`Unknown BROKER_PROVIDER: ${env.BROKER_PROVIDER}`);
  }
}

function buildScannerMonitor(
  repository: WatchlistRepository,
  metrics: MetricsPort,
): ScannerMonitor {
  if (!env.CW_ENABLED) {
    const noop = new ChartsWatcherScannerFeedAdapter({
      wsUrl: '',
      userId: '',
      apiKey: '',
    });
    return new ScannerMonitor({
      feed: noop,
      repository,
      metrics,
      configId: '',
      enabled: false,
    });
  }

  const missing: string[] = [];
  if (!env.CW_USER_ID) missing.push('CW_USER_ID');
  if (!env.CW_API_KEY) missing.push('CW_API_KEY');
  if (!env.CW_CONFIG_ID) missing.push('CW_CONFIG_ID');
  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars for Charts Watcher: ${missing.join(', ')}`,
    );
  }

  const adapter = new ChartsWatcherScannerFeedAdapter({
    wsUrl: env.CW_WS_URL,
    userId: env.CW_USER_ID!,
    apiKey: env.CW_API_KEY!,
  });

  return new ScannerMonitor({
    feed: adapter,
    repository,
    metrics,
    configId: env.CW_CONFIG_ID!,
    enabled: true,
  });
}

function buildDecisionModel(): DecisionModelPort {
  switch (env.DECISION_MODEL) {
    case 'technical':
      return new TechnicalDecisionModelAdapter();
    default:
      throw new Error(`Unknown DECISION_MODEL: ${env.DECISION_MODEL}`);
  }
}

// Single TwelveDataClient instance shared by both adapters (indicators +
// historical bars) — its rate limiter must be unique to stay under the 8 req/min
// free-tier cap.
function buildTwelveDataClient(): TwelveDataClient | null {
  if (!env.TWELVEDATA_API_KEY) return null;
  return new TwelveDataClient({
    apiKey: env.TWELVEDATA_API_KEY,
    baseUrl: env.TWELVEDATA_BASE_URL,
    minIntervalMs: env.TWELVEDATA_MIN_INTERVAL_MS,
  });
}

function buildIndicatorProvider(
  barRepo: BarRepository | null,
  twelveDataClient: TwelveDataClient | null,
): IndicatorPort {
  switch (env.INDICATOR_PROVIDER) {
    case 'alphavantage': {
      if (!env.ALPHA_VANTAGE_API_KEY) {
        throw new Error('Missing required env var: ALPHA_VANTAGE_API_KEY');
      }
      return new AlphaVantageIndicatorAdapter({
        apiKey: env.ALPHA_VANTAGE_API_KEY,
        baseUrl: env.ALPHA_VANTAGE_BASE_URL,
        minIntervalMs: env.ALPHA_VANTAGE_MIN_INTERVAL_MS,
      });
    }
    case 'twelvedata': {
      if (!twelveDataClient) {
        throw new Error('Missing required env var: TWELVEDATA_API_KEY');
      }
      return new TwelveDataIndicatorAdapter(twelveDataClient);
    }
    case 'local': {
      if (!barRepo) {
        throw new Error(
          'INDICATOR_PROVIDER=local requires REDIS_URL (BarRepository unavailable)',
        );
      }
      return new LocalIndicatorAdapter({ bars: barRepo });
    }
    default:
      throw new Error(`Unknown INDICATOR_PROVIDER: ${env.INDICATOR_PROVIDER}`);
  }
}

function buildBarRepository(redis: Redis | null): BarRepository | null {
  if (env.INDICATOR_PROVIDER !== 'local' && env.MARKET_FEED !== 'polygon') {
    return null;
  }
  if (!redis) {
    throw new Error(
      'REDIS_URL is required when INDICATOR_PROVIDER=local or MARKET_FEED=polygon',
    );
  }
  return new RedisBarRepository(redis);
}

function buildMarketFeed(): MarketFeedPort | null {
  if (env.MARKET_FEED === 'none') return null;
  if (env.MARKET_FEED !== 'polygon') {
    throw new Error(`Unknown MARKET_FEED: ${env.MARKET_FEED}`);
  }
  if (!env.POLYGON_API_KEY) {
    throw new Error('Missing required env var: POLYGON_API_KEY');
  }
  return new PolygonMarketFeedAdapter({
    apiKey: env.POLYGON_API_KEY,
    wsUrl: env.POLYGON_WS_URL,
  });
}

// Historical bootstrap is always Twelve Data (independent of INDICATOR_PROVIDER
// since 'local' indicators read from cache, not from a remote indicator API).
function buildHistoricalBars(
  twelveDataClient: TwelveDataClient | null,
): HistoricalBarsPort {
  if (!twelveDataClient) {
    throw new Error(
      'MARKET_FEED=polygon requires TWELVEDATA_API_KEY for historical bootstrap',
    );
  }
  return new TwelveDataHistoricalBarsAdapter(twelveDataClient);
}

function buildWatchlistRepository(redis: Redis | null): WatchlistRepository {
  if (redis) return new RedisWatchlistRepository(redis);
  return new InMemoryWatchlistRepository();
}

function buildTradeContextRepository(
  redis: Redis | null,
): TradeContextRepository {
  if (redis) return new RedisTradeContextRepository(redis);
  return new InMemoryTradeContextRepository();
}

function buildRedis(): Redis | null {
  if (!env.REDIS_URL) return null;
  const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  });
  redis.on('error', (err) => {
    log.warn({ err: err.message }, 'redis error');
  });
  return redis;
}

async function main() {
  const startedAt = Date.now();
  const server = await createServer();

  const metricsAdapter = new PrometheusMetricsAdapter();

  registerAuthMiddleware(server, {
    apiToken: env.API_TOKEN,
    protectedPrefix: '/api/',
  });

  const redis = buildRedis();

  const brokerAdapter = buildBroker(metricsAdapter);
  const barRepository = buildBarRepository(redis);
  const twelveDataClient = buildTwelveDataClient();
  const indicatorAdapter = buildIndicatorProvider(
    barRepository,
    twelveDataClient,
  );
  const decisionModelAdapter = buildDecisionModel();
  const watchlistRepository = buildWatchlistRepository(redis);
  const tradeContextRepository = buildTradeContextRepository(redis);
  const marketHours = new UsMarketHoursAdapter();
  const marketFeedAdapter = buildMarketFeed();

  const scannerMonitorUseCase = buildScannerMonitor(
    watchlistRepository,
    metricsAdapter,
  );
  const evaluateDecisionUseCase = new EvaluateDecision(
    decisionModelAdapter,
    indicatorAdapter,
    brokerAdapter,
  );
  const placeBracketOrderUseCase = new PlaceBracketOrder(brokerAdapter);
  const recordTradeContextUseCase = new RecordTradeContext(
    tradeContextRepository,
  );
  const listWatchlistUseCase = new ListWatchlist(watchlistRepository);
  const getOrdersUseCase = new GetOrders(brokerAdapter, tradeContextRepository);

  // Mutually exclusive runtime modes. With MARKET_FEED=polygon the evaluation
  // is event-driven on each AM bar close; otherwise the legacy DecisionRunner
  // ticks once per minute.
  const usingMarketFeed = marketFeedAdapter !== null;
  const decisionRunnerUseCase = usingMarketFeed
    ? null
    : new DecisionRunner({
        evaluate: evaluateDecisionUseCase,
        placeBracketOrder: placeBracketOrderUseCase,
        recordTradeContext: recordTradeContextUseCase,
        watchlist: watchlistRepository,
        broker: brokerAdapter,
        marketHours,
        metrics: metricsAdapter,
        orderConfig: decisionModelAdapter.orderConfig,
        enabled: env.DECISION_ENABLED,
      });
  const barStreamManagerUseCase =
    usingMarketFeed && barRepository
      ? new BarStreamManager({
          feed: marketFeedAdapter,
          historicalBars: buildHistoricalBars(twelveDataClient),
          barRepo: barRepository,
          watchlist: watchlistRepository,
          evaluate: evaluateDecisionUseCase,
          placeBracketOrder: placeBracketOrderUseCase,
          recordTradeContext: recordTradeContextUseCase,
          broker: brokerAdapter,
          marketHours,
          metrics: metricsAdapter,
          orderConfig: decisionModelAdapter.orderConfig,
          bootstrapBars: env.BOOTSTRAP_BARS,
        })
      : null;

  const grafanaWriter =
    env.GRAFANA_CLOUD_PROM_URL &&
    env.GRAFANA_CLOUD_PROM_USERNAME &&
    env.GRAFANA_CLOUD_PROM_API_KEY
      ? new GrafanaCloudWriter({
          registry: metricsAdapter.registry,
          url: env.GRAFANA_CLOUD_PROM_URL,
          username: env.GRAFANA_CLOUD_PROM_USERNAME,
          apiKey: env.GRAFANA_CLOUD_PROM_API_KEY,
        })
      : null;

  const tickProvider = decisionRunnerUseCase ?? barStreamManagerUseCase;
  const heartbeat =
    env.BETTERSTACK_HEARTBEAT_URL && tickProvider
      ? new Heartbeat({
          url: env.BETTERSTACK_HEARTBEAT_URL,
          tickProvider,
          marketHours,
        })
      : null;

  try {
    await scannerMonitorUseCase.start();
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'scanner monitor start failed (degraded mode — adapter will keep retrying)',
    );
  }

  decisionRunnerUseCase?.start();
  if (barStreamManagerUseCase) {
    try {
      await barStreamManagerUseCase.start();
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'bar stream manager start failed (will keep retrying via reconnect)',
      );
    }
  }
  grafanaWriter?.start();
  heartbeat?.start();

  await server.register(healthRoutes, {
    scannerMonitor: scannerMonitorUseCase,
    marketHours,
    redis,
    broker: brokerAdapter,
    startedAt,
  });
  await server.register(metricsRoutes, { registry: metricsAdapter.registry });
  await server.register(watchlistRoutes, {
    listWatchlist: listWatchlistUseCase,
  });
  await server.register(brokerRoutes, { getOrders: getOrdersUseCase });

  await server.listen({ port: env.PORT, host: env.HOST || '0.0.0.0' });
  const decisionStatus = (() => {
    if (!env.DECISION_ENABLED) return 'disabled';
    if (barStreamManagerUseCase) {
      return `${decisionModelAdapter.name} via barStream (${barStreamManagerUseCase.getStatus()})`;
    }
    if (decisionRunnerUseCase) {
      return `${decisionModelAdapter.name} via runner (${decisionRunnerUseCase.getStatus()})`;
    }
    return 'unknown';
  })();
  log.info(
    {
      port: env.PORT,
      broker: env.BROKER_PROVIDER,
      indicators: env.INDICATOR_PROVIDER,
      marketFeed: env.MARKET_FEED,
      cw: env.CW_ENABLED ? scannerMonitorUseCase.getStatus() : 'disabled',
      decision: decisionStatus,
      redis: redis ? 'connected' : 'in-memory',
      grafana: grafanaWriter ? 'enabled' : 'disabled',
      heartbeat: heartbeat ? 'enabled' : 'disabled',
    },
    'listening',
  );

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    try {
      heartbeat?.stop();
      grafanaWriter?.stop();
      decisionRunnerUseCase?.stop();
      barStreamManagerUseCase?.stop();
      scannerMonitorUseCase.stop();
      await server.close();
      if (redis) await redis.quit();
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'error during shutdown',
      );
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  log.fatal(
    { err: err instanceof Error ? err.message : String(err) },
    'fatal startup error',
  );
  process.exit(1);
});
