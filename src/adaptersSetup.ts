import Redis from 'ioredis';
import { env } from './infrastructure/config/env.js';
import { logger } from './infrastructure/logging/logger.js';
import { TradeStationBrokerAdapter } from './infrastructure/broker/TradeStationBrokerAdapter.js';
import { TradeStationClient } from './infrastructure/tradestation/TradeStationClient.js';
import { TradeStationOrderStreamAdapter } from './infrastructure/orderstream/TradeStationOrderStreamAdapter.js';
import { TradeStationPositionStreamAdapter } from './infrastructure/positionstream/TradeStationPositionStreamAdapter.js';
import { ChartsWatcherScannerFeedAdapter } from './infrastructure/scanner/ChartsWatcherScannerFeedAdapter.js';
import { RedisWatchlistRepository } from './infrastructure/watchlist/RedisWatchlistRepository.js';
import { RedisTradeContextRepository } from './infrastructure/trade/RedisTradeContextRepository.js';
import { RedisBarRepository } from './infrastructure/marketdata/RedisBarRepository.js';
import { TwelveDataHistoricalBarsAdapter } from './infrastructure/marketdata/TwelveDataHistoricalBarsAdapter.js';
import { TwelveDataClient } from './infrastructure/twelvedata/TwelveDataClient.js';
import { LocalIndicatorAdapter } from './infrastructure/indicators/LocalIndicatorAdapter.js';
import { MacdM1CrossOverDecisionModelAdapter } from './infrastructure/decision/MacdM1CrossOverDecisionModelAdapter.js';
import {
  SUPER_CW_CONFIG_ID,
  SuperDecisionModelAdapter,
} from './infrastructure/decision/SuperDecisionModelAdapter.js';
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
  orderStreamAdapter: TradeStationOrderStreamAdapter;
  positionStreamAdapter: TradeStationPositionStreamAdapter;
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

  const tradeStationClient = new TradeStationClient({
    clientId: env.TRADESTATION_CLIENT_ID!,
    clientSecret: env.TRADESTATION_CLIENT_SECRET || '',
    refreshToken: env.TRADESTATION_REFRESH_TOKEN!,
    accountId: env.TRADESTATION_ACCOUNT_ID!,
    simBaseUrl: env.TRADESTATION_SIM_URL,
    liveBaseUrl: env.TRADESTATION_LIVE_URL,
    signinUrl: env.TRADESTATION_SIGNIN_URL,
    metrics,
  });

  const broker = new TradeStationBrokerAdapter({ client: tradeStationClient });
  const orderStreamAdapter = new TradeStationOrderStreamAdapter({
    client: tradeStationClient,
  });
  const positionStreamAdapter = new TradeStationPositionStreamAdapter({
    client: tradeStationClient,
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

  // Each strategy owns its own watchlist (separate Redis keyspace via
  // keyPrefix) and points to its own CW scanner. The Super model's config_id
  // is exported as a constant from its adapter (it's part of the model's
  // definition); MacdM1CrossOver's stays in env for now.
  const macdM1CrossOverWatchlist = new RedisWatchlistRepository(redis);
  const macdM1CrossOverModel = new MacdM1CrossOverDecisionModelAdapter({
    broker,
    indicators,
  });
  const macdM1CrossOverStrategy: ConfiguredStrategy = {
    strategy: {
      name: 'MacdM1CrossOver',
      model: macdM1CrossOverModel,
      watchlist: macdM1CrossOverWatchlist,
      orderConfig: macdM1CrossOverModel.orderConfig,
    },
    cwConfigId: env.CW_CONFIG_ID!,
    watchlistRepo: macdM1CrossOverWatchlist,
  };

  const superWatchlist = new RedisWatchlistRepository(redis, {
    keyPrefix: 'cw:wl:super',
  });
  const superModel = new SuperDecisionModelAdapter({ broker, indicators });
  const superStrategy: ConfiguredStrategy = {
    strategy: {
      name: 'Super',
      model: superModel,
      watchlist: superWatchlist,
      orderConfig: superModel.orderConfig,
      trailToBreakEvenAtProfit: 0.005,
    },
    cwConfigId: SUPER_CW_CONFIG_ID,
    watchlistRepo: superWatchlist,
  };

  return {
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
    strategies: [macdM1CrossOverStrategy, superStrategy],
  };
}
