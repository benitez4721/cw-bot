import { createServer } from './infrastructure/http/server.js';
import { env } from './infrastructure/config/env.js';
import { logger } from './infrastructure/logging/logger.js';
import { setupAdapters } from './adaptersSetup.js';
import { PlaceBracketOrder } from './application/broker/PlaceBracketOrder.js';
import { CheckOpenTrades } from './application/trade/CheckOpenTrades.js';
import { CloseTrade } from './application/trade/CloseTrade.js';
import { MaybeMoveStopToBreakEven } from './application/trade/MaybeMoveStopToBreakEven.js';
import { RecordTradeContext } from './application/trade/RecordTradeContext.js';
import { ScannerMonitor } from './application/watchlist/ScannerMonitor.js';
import { ListWatchlist } from './application/watchlist/ListWatchlist.js';
import { GetOrders } from './application/broker/GetOrders.js';
import { watchlistRoutes } from './infrastructure/http/watchlistRoutes.js';
import { brokerRoutes } from './infrastructure/http/brokerRoutes.js';
import { brokerStreamRoutes } from './infrastructure/http/brokerStreamRoutes.js';
import { healthRoutes } from './infrastructure/http/healthRoutes.js';
import { metricsRoutes } from './infrastructure/http/metricsRoutes.js';
import { registerAuthMiddleware } from './infrastructure/http/authMiddleware.js';
import { BarStreamManager } from './application/marketdata/BarStreamManager.js';
import { OrderStreamManager } from './application/orderstream/OrderStreamManager.js';
import { PositionStreamManager } from './application/positionstream/PositionStreamManager.js';
import { GrafanaCloudWriter } from './infrastructure/metrics/GrafanaCloudWriter.js';
import { Heartbeat } from './application/heartbeat/Heartbeat.js';

const log = logger.child({ component: 'main' });

function requireEnv(): void {
  const missing: string[] = [];
  if (!env.REDIS_URL) missing.push('REDIS_URL');
  if (!env.TRADESTATION_CLIENT_ID) missing.push('TRADESTATION_CLIENT_ID');
  if (!env.TRADESTATION_REFRESH_TOKEN)
    missing.push('TRADESTATION_REFRESH_TOKEN');
  if (!env.TRADESTATION_ACCOUNT_ID) missing.push('TRADESTATION_ACCOUNT_ID');
  if (!env.POLYGON_API_KEY) missing.push('POLYGON_API_KEY');
  if (!env.TWELVEDATA_API_KEY) missing.push('TWELVEDATA_API_KEY');
  if (!env.CW_USER_ID) missing.push('CW_USER_ID');
  if (!env.CW_API_KEY) missing.push('CW_API_KEY');
  if (!env.CW_CONFIG_ID) missing.push('CW_CONFIG_ID');
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}

async function main() {
  requireEnv();

  const startedAt = Date.now();
  const server = await createServer();
  const {
    redis,
    metrics,
    broker,
    orderStreamAdapter,
    positionStreamAdapter,
    tradeRepo,
    barRepo,
    marketHours,
    marketFeed,
    historicalBars,
    scannerFeed,
    strategies,
  } = setupAdapters();

  registerAuthMiddleware(server, {
    apiToken: env.API_TOKEN,
    protectedPrefix: '/api/',
  });

  const scanners = strategies.map(
    (s) =>
      new ScannerMonitor({
        feed: scannerFeed,
        repository: s.watchlistRepo,
        metrics,
        configId: s.cwConfigId,
      }),
  );

  const placeBracketOrder = new PlaceBracketOrder(broker);
  const recordTradeContext = new RecordTradeContext(tradeRepo);
  const closeTrade = new CloseTrade(tradeRepo);
  const checkOpenTrades = new CheckOpenTrades({
    tradeRepo,
    broker,
    closeTrade,
  });
  const maybeMoveStopToBreakEven = new MaybeMoveStopToBreakEven({
    tradeRepo,
    broker,
  });
  // Public watchlist endpoints expose the first strategy's watchlist for now.
  // When a second strategy is added, expose a per-model lookup instead.
  const listWatchlist = new ListWatchlist(strategies[0].watchlistRepo);
  const getOrders = new GetOrders(broker, tradeRepo);

  const orderStreamMgr = new OrderStreamManager({ stream: orderStreamAdapter });
  const positionStreamMgr = new PositionStreamManager({
    stream: positionStreamAdapter,
  });

  const barStream = new BarStreamManager({
    feed: marketFeed,
    historicalBars,
    barRepo,
    strategies: strategies.map((s) => s.strategy),
    placeBracketOrder,
    recordTradeContext,
    checkOpenTrades,
    maybeMoveStopToBreakEven,
    marketHours,
    metrics,
    bootstrapBars: env.BOOTSTRAP_BARS,
  });

  const grafana =
    env.GRAFANA_CLOUD_PROM_URL &&
    env.GRAFANA_CLOUD_PROM_USERNAME &&
    env.GRAFANA_CLOUD_PROM_API_KEY
      ? new GrafanaCloudWriter({
          registry: metrics.registry,
          url: env.GRAFANA_CLOUD_PROM_URL,
          username: env.GRAFANA_CLOUD_PROM_USERNAME,
          apiKey: env.GRAFANA_CLOUD_PROM_API_KEY,
        })
      : null;

  const heartbeat = env.BETTERSTACK_HEARTBEAT_URL
    ? new Heartbeat({
        url: env.BETTERSTACK_HEARTBEAT_URL,
        tickProvider: barStream,
        marketHours,
      })
    : null;

  for (const scanner of scanners) {
    try {
      await scanner.start();
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'scanner monitor start failed (degraded mode — adapter will keep retrying)',
      );
    }
  }
  try {
    await barStream.start();
  } catch (err) {
    log.error(
      { err: err instanceof Error ? err.message : String(err) },
      'bar stream manager start failed (will keep retrying via reconnect)',
    );
  }
  // Streams de broker arrancan warm: el adapter mantiene la conexión a TS
  // viva con reconexión interna. Cualquier error de start() es no fatal.
  orderStreamMgr
    .start()
    .catch((err) =>
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'order stream start failed',
      ),
    );
  positionStreamMgr
    .start()
    .catch((err) =>
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'position stream start failed',
      ),
    );
  grafana?.start();
  heartbeat?.start();

  await server.register(healthRoutes, {
    scannerMonitor: scanners[0],
    marketHours,
    redis,
    broker,
    startedAt,
  });
  await server.register(metricsRoutes, { registry: metrics.registry });
  await server.register(watchlistRoutes, { listWatchlist });
  await server.register(brokerRoutes, { getOrders });
  await server.register(brokerStreamRoutes, {
    orderStream: orderStreamMgr,
    positionStream: positionStreamMgr,
  });

  await server.listen({ port: env.PORT, host: env.HOST || '0.0.0.0' });

  const decisionStatus = env.DECISION_ENABLED
    ? `${strategies.map((s) => s.strategy.name).join(',')} via barStream (${barStream.getStatus()})`
    : 'disabled';
  log.info(
    {
      port: env.PORT,
      cw: scanners.map((s) => s.getStatus()),
      decision: decisionStatus,
      grafana: grafana ? 'enabled' : 'disabled',
      heartbeat: heartbeat ? 'enabled' : 'disabled',
    },
    'listening',
  );

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'shutting down');
    try {
      heartbeat?.stop();
      grafana?.stop();
      barStream.stop();
      orderStreamMgr.stop();
      positionStreamMgr.stop();
      for (const scanner of scanners) scanner.stop();
      await server.close();
      await redis.quit();
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
