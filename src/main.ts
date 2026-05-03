import { createServer } from './infrastructure/http/server.js';
import { env } from './infrastructure/config/env.js';
import type { BrokerPort } from './domain/broker/BrokerPort.js';
import { TradeStationAdapter } from './infrastructure/tradestation/TradeStationAdapter.js';
import { PlaceBracketOrder } from './application/broker/PlaceBracketOrder.js';
import { ChartsWatcherAdapter } from './infrastructure/chartswatcher/ChartsWatcherAdapter.js';
import { InMemoryWatchlistRepository } from './infrastructure/watchlist/InMemoryWatchlistRepository.js';
import { ScannerMonitor } from './application/watchlist/ScannerMonitor.js';
import type { IndicatorPort } from './domain/indicators/IndicatorPort.js';
import { AlphaVantageAdapter } from './infrastructure/alphavantage/AlphaVantageAdapter.js';
import type { DecisionModelPort } from './domain/decision/DecisionPort.js';
import { TechnicalDecisionModel } from './infrastructure/decision/TechnicalDecisionModel.js';
import { EvaluateDecision } from './application/decision/EvaluateDecision.js';
import { DecisionRunner } from './application/decision/DecisionRunner.js';

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

function buildDecisionModel(): DecisionModelPort {
  switch (env.DECISION_MODEL) {
    case 'technical':
      return new TechnicalDecisionModel({
        quantity: env.DECISION_QUANTITY,
        entryOffset: env.DECISION_ENTRY_OFFSET,
        stopOffset: env.DECISION_STOP_OFFSET,
        takeProfitOffset: env.DECISION_TP_OFFSET,
      });
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
      });
    }
    default:
      throw new Error(`Unknown INDICATOR_PROVIDER: ${env.INDICATOR_PROVIDER}`);
  }
}

async function main() {
  const server = await createServer();

  server.get('/health', async () => ({ status: 'ok' }));

  // Adapters
  const brokerAdapter = buildBroker();
  const indicatorAdapter = buildIndicatorProvider();
  const decisionModelAdapter = buildDecisionModel();

  // Repositories
  const watchlistRepository = new InMemoryWatchlistRepository();

  // Use cases
  const scannerMonitorUseCase = buildScannerMonitor(watchlistRepository);
  const evaluateDecisionUseCase = new EvaluateDecision(
    decisionModelAdapter,
    indicatorAdapter,
    brokerAdapter,
  );
  const placeBracketOrderUseCase = new PlaceBracketOrder(brokerAdapter);
  const decisionRunnerUseCase = new DecisionRunner({
    evaluate: evaluateDecisionUseCase,
    placeBracketOrder: placeBracketOrderUseCase,
    watchlist: watchlistRepository,
    broker: brokerAdapter,
    orderConfig: decisionModelAdapter.orderConfig,
    intervalMs: env.DECISION_INTERVAL_MS,
    enabled: env.DECISION_ENABLED,
  });

  try {
    await scannerMonitorUseCase.start();
  } catch (err) {
    console.error(
      '[cw-bot] ScannerMonitor start failed (degraded mode — adapter will keep retrying):',
      err,
    );
  }

  decisionRunnerUseCase.start();

  await server.listen({ port: env.PORT, host: env.HOST || '0.0.0.0' });
  console.log(
    `[cw-bot] Listening on :${env.PORT} — broker=${env.BROKER_PROVIDER} cw=${env.CW_ENABLED ? `enabled (${scannerMonitorUseCase.getStatus()})` : 'disabled'} decision=${env.DECISION_ENABLED ? `${decisionModelAdapter.name} (${decisionRunnerUseCase.getStatus()}, interval=${env.DECISION_INTERVAL_MS}ms)` : 'disabled'}`,
  );

  const shutdown = async (signal: string) => {
    console.log(`[cw-bot] ${signal} received, shutting down...`);
    try {
      decisionRunnerUseCase.stop();
      scannerMonitorUseCase.stop();
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
