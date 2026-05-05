import Redis from 'ioredis';
import { createServer } from './infrastructure/http/server.js';
import { env } from './infrastructure/config/env.js';
import { logger } from './infrastructure/logging/logger.js';
import { TradeStationAdapter } from './infrastructure/tradestation/TradeStationAdapter.js';
import { PlaceBracketOrder } from './application/broker/PlaceBracketOrder.js';
import { ChartsWatcherAdapter } from './infrastructure/chartswatcher/ChartsWatcherAdapter.js';
import { InMemoryWatchlistRepository } from './infrastructure/watchlist/InMemoryWatchlistRepository.js';
import { RedisWatchlistRepository } from './infrastructure/watchlist/RedisWatchlistRepository.js';
import type { WatchlistRepository } from './domain/watchlist/WatchlistRepository.js';
import { ScannerMonitor } from './application/watchlist/ScannerMonitor.js';
import { ListWatchlist } from './application/watchlist/ListWatchlist.js';
import { GetOrders } from './application/broker/GetOrders.js';
import { watchlistRoutes } from './infrastructure/http/watchlistRoutes.js';
import { brokerRoutes } from './infrastructure/http/brokerRoutes.js';
import { healthRoutes } from './infrastructure/http/healthRoutes.js';
import { metricsRoutes } from './infrastructure/http/metricsRoutes.js';
import { registerAuthMiddleware } from './infrastructure/http/authMiddleware.js';
import type { IndicatorPort } from './domain/indicators/IndicatorPort.js';
import { AlphaVantageAdapter } from './infrastructure/alphavantage/AlphaVantageAdapter.js';
import { TwelveDataAdapter } from './infrastructure/twelvedata/TwelveDataAdapter.js';
import type { DecisionModelPort } from './domain/decision/DecisionPort.js';
import { TechnicalDecisionModel } from './infrastructure/decision/TechnicalDecisionModel.js';
import { EvaluateDecision } from './application/decision/EvaluateDecision.js';
import { DecisionRunner } from './application/decision/DecisionRunner.js';
import { UsMarketHours } from './infrastructure/market/UsMarketHours.js';
import { PrometheusMetricsAdapter } from './infrastructure/metrics/PrometheusMetricsAdapter.js';
import { GrafanaCloudWriter } from './infrastructure/metrics/GrafanaCloudWriter.js';
import { Heartbeat } from './application/heartbeat/Heartbeat.js';
import type { MetricsPort } from './domain/metrics/MetricsPort.js';

const log = logger.child({ component: 'main' });

function buildBroker(metrics: MetricsPort): TradeStationAdapter {
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
      return new TradeStationAdapter({
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
    const noop = new ChartsWatcherAdapter({
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

  const adapter = new ChartsWatcherAdapter({
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
      return new TechnicalDecisionModel();
    default:
      throw new Error(`Unknown DECISION_MODEL: ${env.DECISION_MODEL}`);
  }
}

function buildIndicatorProvider(): IndicatorPort {
  switch (env.INDICATOR_PROVIDER) {
    case 'alphavantage': {
      if (!env.ALPHA_VANTAGE_API_KEY) {
        throw new Error('Missing required env var: ALPHA_VANTAGE_API_KEY');
      }
      return new AlphaVantageAdapter({
        apiKey: env.ALPHA_VANTAGE_API_KEY,
        baseUrl: env.ALPHA_VANTAGE_BASE_URL,
        minIntervalMs: env.ALPHA_VANTAGE_MIN_INTERVAL_MS,
      });
    }
    case 'twelvedata': {
      if (!env.TWELVEDATA_API_KEY) {
        throw new Error('Missing required env var: TWELVEDATA_API_KEY');
      }
      return new TwelveDataAdapter({
        apiKey: env.TWELVEDATA_API_KEY,
        baseUrl: env.TWELVEDATA_BASE_URL,
        minIntervalMs: env.TWELVEDATA_MIN_INTERVAL_MS,
      });
    }
    default:
      throw new Error(`Unknown INDICATOR_PROVIDER: ${env.INDICATOR_PROVIDER}`);
  }
}

function buildWatchlistRepository(redis: Redis | null): WatchlistRepository {
  if (redis) return new RedisWatchlistRepository(redis);
  return new InMemoryWatchlistRepository();
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
  const indicatorAdapter = buildIndicatorProvider();
  const decisionModelAdapter = buildDecisionModel();
  const watchlistRepository = buildWatchlistRepository(redis);
  const marketHours = new UsMarketHours();

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
  const listWatchlistUseCase = new ListWatchlist(watchlistRepository);
  const getOrdersUseCase = new GetOrders(brokerAdapter);
  const decisionRunnerUseCase = new DecisionRunner({
    evaluate: evaluateDecisionUseCase,
    placeBracketOrder: placeBracketOrderUseCase,
    watchlist: watchlistRepository,
    broker: brokerAdapter,
    marketHours,
    metrics: metricsAdapter,
    orderConfig: decisionModelAdapter.orderConfig,
    intervalMs: 60_000,
    enabled: env.DECISION_ENABLED,
  });

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

  const heartbeat = env.BETTERSTACK_HEARTBEAT_URL
    ? new Heartbeat({
        url: env.BETTERSTACK_HEARTBEAT_URL,
        decisionRunner: decisionRunnerUseCase,
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

  decisionRunnerUseCase.start();
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
  log.info(
    {
      port: env.PORT,
      broker: env.BROKER_PROVIDER,
      cw: env.CW_ENABLED ? scannerMonitorUseCase.getStatus() : 'disabled',
      decision: env.DECISION_ENABLED
        ? `${decisionModelAdapter.name} (${decisionRunnerUseCase.getStatus()})`
        : 'disabled',
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
      decisionRunnerUseCase.stop();
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
