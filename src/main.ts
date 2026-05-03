import { createServer } from './infrastructure/http/server.js';
import { env } from './infrastructure/config/env.js';
import type { BrokerPort } from './domain/broker/BrokerPort.js';
import { TradeStationAdapter } from './infrastructure/tradestation/TradeStationAdapter.js';
import { PlaceOrder } from './application/broker/PlaceOrder.js';
import { CancelOrder } from './application/broker/CancelOrder.js';
import { ReplaceOrder } from './application/broker/ReplaceOrder.js';
import { GetBalances } from './application/broker/GetBalances.js';
import { GetPositions } from './application/broker/GetPositions.js';
import { GetOrders } from './application/broker/GetOrders.js';
import { GetHistoricalOrders } from './application/broker/GetHistoricalOrders.js';
import { GetQuote } from './application/broker/GetQuote.js';
import { registerBrokerRoutes } from './infrastructure/http/brokerRoutes.js';
import { ChartsWatcherAdapter } from './infrastructure/chartswatcher/ChartsWatcherAdapter.js';
import { InMemoryWatchlistRepository } from './infrastructure/watchlist/InMemoryWatchlistRepository.js';
import { ScannerMonitor } from './application/watchlist/ScannerMonitor.js';
import { registerWatchlistRoutes } from './infrastructure/http/watchlistRoutes.js';
import type { IndicatorPort } from './domain/indicators/IndicatorPort.js';
import { AlphaVantageAdapter } from './infrastructure/alphavantage/AlphaVantageAdapter.js';
import { GetEMA } from './application/indicators/GetEMA.js';
import { GetMACD } from './application/indicators/GetMACD.js';
import { GetMACDSeries } from './application/indicators/GetMACDSeries.js';
import { GetVWAP } from './application/indicators/GetVWAP.js';
import { registerIndicatorRoutes } from './infrastructure/http/indicatorRoutes.js';

function buildBroker(): BrokerPort {
  switch (env.BROKER_PROVIDER) {
    case 'tradestation': {
      const missing: string[] = [];
      if (!env.TRADESTATION_CLIENT_ID) missing.push('TRADESTATION_CLIENT_ID');
      if (!env.TRADESTATION_REFRESH_TOKEN) missing.push('TRADESTATION_REFRESH_TOKEN');
      if (!env.TRADESTATION_ACCOUNT_ID) missing.push('TRADESTATION_ACCOUNT_ID');
      if (missing.length > 0) {
        throw new Error(`Missing required env vars for TradeStation: ${missing.join(', ')}`);
      }
      return new TradeStationAdapter({
        clientId: env.TRADESTATION_CLIENT_ID!,
        clientSecret: env.TRADESTATION_CLIENT_SECRET || '',
        refreshToken: env.TRADESTATION_REFRESH_TOKEN!,
        accountId: env.TRADESTATION_ACCOUNT_ID!,
        simBaseUrl: env.TRADESTATION_SIM_URL,
        liveBaseUrl: env.TRADESTATION_LIVE_URL,
        signinUrl: env.TRADESTATION_SIGNIN_URL,
      });
    }
    default:
      throw new Error(`Unknown BROKER_PROVIDER: ${env.BROKER_PROVIDER}`);
  }
}

function buildScannerMonitor(repository: InMemoryWatchlistRepository): ScannerMonitor {
  if (!env.CW_ENABLED) {
    const noop = new ChartsWatcherAdapter({ wsUrl: '', userId: '', apiKey: '' });
    return new ScannerMonitor({
      feed: noop,
      repository,
      configId: '',
      enabled: false,
    });
  }

  const missing: string[] = [];
  if (!env.CW_USER_ID) missing.push('CW_USER_ID');
  if (!env.CW_API_KEY) missing.push('CW_API_KEY');
  if (!env.CW_CONFIG_ID) missing.push('CW_CONFIG_ID');
  if (missing.length > 0) {
    throw new Error(`Missing required env vars for Charts Watcher: ${missing.join(', ')}`);
  }

  const adapter = new ChartsWatcherAdapter({
    wsUrl: env.CW_WS_URL,
    userId: env.CW_USER_ID!,
    apiKey: env.CW_API_KEY!,
  });

  return new ScannerMonitor({
    feed: adapter,
    repository,
    configId: env.CW_CONFIG_ID!,
    enabled: true,
  });
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
      });
    }
    default:
      throw new Error(`Unknown INDICATOR_PROVIDER: ${env.INDICATOR_PROVIDER}`);
  }
}

async function main() {
  const server = await createServer();

  server.get('/health', async () => ({ status: 'ok' }));

  const broker = buildBroker();
  const watchlistRepository = new InMemoryWatchlistRepository();
  const monitor = buildScannerMonitor(watchlistRepository);
  const indicators = buildIndicatorProvider();

  registerBrokerRoutes({
    server,
    placeOrder: new PlaceOrder(broker),
    cancelOrder: new CancelOrder(broker),
    replaceOrder: new ReplaceOrder(broker),
    getBalances: new GetBalances(broker),
    getPositions: new GetPositions(broker),
    getOrders: new GetOrders(broker),
    getHistoricalOrders: new GetHistoricalOrders(broker),
    getQuote: new GetQuote(broker),
  });

  registerWatchlistRoutes({ server, repository: watchlistRepository, monitor });

  registerIndicatorRoutes({
    server,
    getEMA: new GetEMA(indicators),
    getMACD: new GetMACD(indicators),
    getMACDSeries: new GetMACDSeries(indicators),
    getVWAP: new GetVWAP(indicators),
  });

  try {
    await monitor.start();
  } catch (err) {
    console.error(
      '[cw-bot] ScannerMonitor start failed (degraded mode — adapter will keep retrying):',
      err,
    );
  }

  await server.listen({ port: env.PORT, host: env.HOST || '0.0.0.0' });
  console.log(
    `[cw-bot] Listening on :${env.PORT} — broker=${env.BROKER_PROVIDER} cw=${env.CW_ENABLED ? `enabled (${monitor.getStatus()})` : 'disabled'}`,
  );

  const shutdown = async (signal: string) => {
    console.log(`[cw-bot] ${signal} received, shutting down...`);
    try {
      monitor.stop();
      await server.close();
    } catch (err) {
      console.error('[cw-bot] Error during shutdown:', err);
    } finally {
      process.exit(0);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[cw-bot] Fatal startup error:', err);
  process.exit(1);
});
