import Redis from 'ioredis';
import { env } from './infrastructure/config/env.js';
import { logger } from './infrastructure/logging/logger.js';
import { TradeStationBrokerAdapter } from './infrastructure/broker/tradestation/TradeStationBrokerAdapter.js';
import { TradeStationClient } from './infrastructure/broker/tradestation/TradeStationClient.js';
import { TradeStationOrderStreamAdapter } from './infrastructure/broker/tradestation/TradeStationOrderStreamAdapter.js';
import { TradeStationPositionStreamAdapter } from './infrastructure/broker/tradestation/TradeStationPositionStreamAdapter.js';
import { ChartsWatcherScannerFeedAdapter } from './infrastructure/scanner/ChartsWatcherScannerFeedAdapter.js';
import { RedisWatchlistRepository } from './infrastructure/watchlist/RedisWatchlistRepository.js';
import { RedisTradeContextRepository } from './infrastructure/trade/RedisTradeContextRepository.js';
import { RedisBarRepository } from './infrastructure/marketdata/RedisBarRepository.js';
import { TwelveDataHistoricalBarsAdapter } from './infrastructure/marketdata/TwelveDataHistoricalBarsAdapter.js';
import { TwelveDataClient } from './infrastructure/twelvedata/TwelveDataClient.js';
import { LocalIndicatorAdapter } from './infrastructure/indicators/LocalIndicatorAdapter.js';
import { MacdM1CrossOverDecisionModel } from './domain/decision/models/MacdM1CrossOverDecisionModel.js';
import { SuperDecisionModel } from './domain/decision/models/SuperDecisionModel.js';
import { PolygonMarketFeedAdapter } from './infrastructure/marketdata/PolygonMarketFeedAdapter.js';
import { UsMarketHoursAdapter } from './infrastructure/market/UsMarketHoursAdapter.js';
import { PrometheusMetricsAdapter } from './infrastructure/metrics/PrometheusMetricsAdapter.js';
import type { DecisionStrategy } from './domain/decision/DecisionStrategy.js';
import type { EventStrategy } from './domain/decision/EventStrategy.js';

const log = logger.child({ component: 'adaptersSetup' });

export interface ConfiguredStrategy extends DecisionStrategy {
  // The CW scanner config that feeds this strategy's watchlist. Each model
  // has its own scanner instance so watchlists stay decoupled.
  cwConfigId: string;
}

export interface Adapters {
  redis: Redis;
  metrics: PrometheusMetricsAdapter;
  broker: TradeStationBrokerAdapter;
  // Unión de los `accountId` declarados por las estrategias activas. Por cada
  // accountId distinto se abre un websocket de orders y otro de positions
  // (cada stream TS es por cuenta).
  accountIds: readonly string[];
  // Un stream adapter por accountId. Cada uno encapsula UN websocket contra
  // el endpoint /v3/brokerage/stream/accounts/{accountId}/{orders,positions}.
  orderStreamAdaptersByAccount: ReadonlyMap<
    string,
    TradeStationOrderStreamAdapter
  >;
  positionStreamAdaptersByAccount: ReadonlyMap<
    string,
    TradeStationPositionStreamAdapter
  >;
  tradeRepo: RedisTradeContextRepository;
  barRepo: RedisBarRepository;
  marketHours: UsMarketHoursAdapter;
  marketFeed: PolygonMarketFeedAdapter;
  historicalBars: TwelveDataHistoricalBarsAdapter;
  scannerFeed: ChartsWatcherScannerFeedAdapter;
  strategies: ConfiguredStrategy[];
  eventStrategies: EventStrategy[];
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
    simBaseUrl: env.TRADESTATION_SIM_URL,
    liveBaseUrl: env.TRADESTATION_LIVE_URL,
    signinUrl: env.TRADESTATION_SIGNIN_URL,
    metrics,
  });

  const broker = new TradeStationBrokerAdapter({ client: tradeStationClient });

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
  // keyPrefix) and points to its own CW scanner. The CW config_id is
  // infra wiring (opaque pointer to ChartsWatcher); the upstream RVOL
  // filter that CW applies is part of each strategy spec, but the ID
  // itself lives here, hardcoded — invariant across deploys.
  const macdM1CrossOverWatchlist = new RedisWatchlistRepository(redis);
  const macdM1CrossOverModel = new MacdM1CrossOverDecisionModel({
    broker,
    indicators,
  });
  const macdM1CrossOverStrategy: ConfiguredStrategy = {
    name: 'MacdM1CrossOver',
    model: macdM1CrossOverModel,
    watchlist: macdM1CrossOverWatchlist,
    trailToBreakEvenAtProfit: 0.01,
    cwConfigId: '69b85e8d373a8a104a52803b',
    accountId: env.TRADESTATION_ACCOUNT_ID_2!,
  };

  const superWatchlist = new RedisWatchlistRepository(redis, {
    keyPrefix: 'cw:wl:super',
  });
  const superModel = new SuperDecisionModel({ broker, indicators });
  // Cada estrategia declara explícitamente contra qué cuenta opera. El env
  // `TRADESTATION_ACCOUNT_ID` se usa acá como bootstrap por convención;
  // cambialo por una cuenta distinta si querés rutear los trades a otra.
  const superStrategy: ConfiguredStrategy = {
    name: 'Super',
    model: superModel,
    watchlist: superWatchlist,
    trailToBreakEvenAtProfit: 0.01,
    cwConfigId: '69f6bec1f52a7e93e345cd0c',
    accountId: env.TRADESTATION_ACCOUNT_ID!,
  };

  // Modelos event-driven (sin DecisionModel, sin watchlist): el AlertEventManager
  // se suscribe directo a la alerta CW y dispara placeTrailingBracketOrder al
  // recibir cada NewAlert. Convive en paralelo con los DecisionStrategy.
  const highOfDayAlert: EventStrategy = {
    name: 'HighOfDayAlert',
    cwConfigId: '68ab7ca8a42020253d351a52',
    quantity: 2000,
    trailingStopPercent: 8,
    entryBufferBps: 0,
    accountId: env.TRADESTATION_ACCOUNT_ID!,
  };

  const strategies = [superStrategy, macdM1CrossOverStrategy];
  const eventStrategies = [highOfDayAlert];

  // Unión de cuentas declaradas por las estrategias. Por cada accountId
  // distinto se abre un websocket de orders y otro de positions.
  const accountIds: readonly string[] = Array.from(
    new Set<string>([
      ...strategies.map((s) => s.accountId),
      ...eventStrategies.map((s) => s.accountId),
    ]),
  );
  if (accountIds.length === 0) {
    throw new Error(
      'no accountIds configured — at least one strategy must declare accountId',
    );
  }

  const orderStreamAdaptersByAccount = new Map(
    accountIds.map((accountId) => [
      accountId,
      new TradeStationOrderStreamAdapter({
        client: tradeStationClient,
        accountId,
      }),
    ]),
  );
  const positionStreamAdaptersByAccount = new Map(
    accountIds.map((accountId) => [
      accountId,
      new TradeStationPositionStreamAdapter({
        client: tradeStationClient,
        accountId,
      }),
    ]),
  );

  return {
    redis,
    metrics,
    broker,
    accountIds,
    orderStreamAdaptersByAccount,
    positionStreamAdaptersByAccount,
    tradeRepo,
    barRepo,
    marketHours,
    marketFeed,
    historicalBars,
    scannerFeed,
    strategies,
    eventStrategies,
  };
}
