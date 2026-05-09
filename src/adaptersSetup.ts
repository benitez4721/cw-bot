import Redis from 'ioredis';
import { env } from './infrastructure/config/env.js';
import { logger } from './infrastructure/logging/logger.js';
import { TradeStationBrokerAdapter } from './infrastructure/broker/TradeStationBrokerAdapter.js';
import { ChartsWatcherScannerFeedAdapter } from './infrastructure/scanner/ChartsWatcherScannerFeedAdapter.js';
import { RedisWatchlistRepository } from './infrastructure/watchlist/RedisWatchlistRepository.js';
import { RedisTradeContextRepository } from './infrastructure/trade/RedisTradeContextRepository.js';
import { RedisBarRepository } from './infrastructure/marketdata/RedisBarRepository.js';
import { TwelveDataHistoricalBarsAdapter } from './infrastructure/marketdata/TwelveDataHistoricalBarsAdapter.js';
import { TwelveDataClient } from './infrastructure/twelvedata/TwelveDataClient.js';
import { LocalIndicatorAdapter } from './infrastructure/indicators/LocalIndicatorAdapter.js';
import { TechnicalDecisionModelAdapter } from './infrastructure/decision/TechnicalDecisionModelAdapter.js';
import { PolygonMarketFeedAdapter } from './infrastructure/marketdata/PolygonMarketFeedAdapter.js';
import { UsMarketHoursAdapter } from './infrastructure/market/UsMarketHoursAdapter.js';
import { PrometheusMetricsAdapter } from './infrastructure/metrics/PrometheusMetricsAdapter.js';
import type { DecisionStrategy } from './domain/decision/DecisionStrategy.js';

const log = logger.child({ component: 'adaptersSetup' });

export interface ConfiguredStrategy {
  strategy: DecisionStrategy;
  // The CW scanner config that feeds this strategy's watchlist. Each model has
  // its own scanner instance so watchlists stay decoupled.
  cwConfigId: string;
  // Exposed so main.ts can wire the ScannerMonitor and the public watchlist
  // endpoints to the same underlying repo instance.
  watchlistRepo: RedisWatchlistRepository;
}

export interface Adapters {
  redis: Redis;
  metrics: PrometheusMetricsAdapter;
  broker: TradeStationBrokerAdapter;
  tradeRepo: RedisTradeContextRepository;
  barRepo: RedisBarRepository;
  marketHours: UsMarketHoursAdapter;
  marketFeed: PolygonMarketFeedAdapter;
  historicalBars: TwelveDataHistoricalBarsAdapter;
  scannerFeed: ChartsWatcherScannerFeedAdapter;
  strategies: ConfiguredStrategy[];
}

export function setupAdapters(): Adapters {
  const metrics = new PrometheusMetricsAdapter();

  const redis = new Redis(env.REDIS_URL!, {
    maxRetriesPerRequest: 3,
    lazyConnect: false,
  });
  redis.on('error', (err) => {
    log.warn({ err: err.message }, 'redis error');
  });

  const broker = new TradeStationBrokerAdapter({
    clientId: env.TRADESTATION_CLIENT_ID!,
    clientSecret: env.TRADESTATION_CLIENT_SECRET || '',
    refreshToken: env.TRADESTATION_REFRESH_TOKEN!,
    accountId: env.TRADESTATION_ACCOUNT_ID!,
    simBaseUrl: env.TRADESTATION_SIM_URL,
    liveBaseUrl: env.TRADESTATION_LIVE_URL,
    signinUrl: env.TRADESTATION_SIGNIN_URL,
    metrics,
  });

  const tradeRepo = new RedisTradeContextRepository(redis);
  const barRepo = new RedisBarRepository(redis);

  // Single TwelveDataClient instance — its rate limiter must be unique to stay
  // under the 8 req/min free-tier cap.
  const twelveDataClient = new TwelveDataClient({
    apiKey: env.TWELVEDATA_API_KEY!,
    baseUrl: env.TWELVEDATA_BASE_URL,
    minIntervalMs: env.TWELVEDATA_MIN_INTERVAL_MS,
  });

  const indicators = new LocalIndicatorAdapter({ bars: barRepo });
  const marketHours = new UsMarketHoursAdapter();
  const marketFeed = new PolygonMarketFeedAdapter({
    apiKey: env.POLYGON_API_KEY!,
    wsUrl: env.POLYGON_WS_URL,
  });
  const historicalBars = new TwelveDataHistoricalBarsAdapter(twelveDataClient);

  const scannerFeed = new ChartsWatcherScannerFeedAdapter({
    wsUrl: env.CW_WS_URL,
    userId: env.CW_USER_ID!,
    apiKey: env.CW_API_KEY!,
  });

  // Single strategy for now. Adding a second model means appending another
  // entry here with its own watchlistRepo (different keyPrefix) and cwConfigId
  // (read from CW_CONFIG_ID_<MODEL_UPPER>). No other call site changes.
  const technicalWatchlist = new RedisWatchlistRepository(redis);
  const technicalModel = new TechnicalDecisionModelAdapter({
    broker,
    indicators,
  });
  const technicalStrategy: ConfiguredStrategy = {
    strategy: {
      name: 'technical',
      model: technicalModel,
      watchlist: technicalWatchlist,
      orderConfig: technicalModel.orderConfig,
    },
    cwConfigId: env.CW_CONFIG_ID!,
    watchlistRepo: technicalWatchlist,
  };

  return {
    redis,
    metrics,
    broker,
    tradeRepo,
    barRepo,
    marketHours,
    marketFeed,
    historicalBars,
    scannerFeed,
    strategies: [technicalStrategy],
  };
}
