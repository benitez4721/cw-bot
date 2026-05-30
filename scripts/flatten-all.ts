import Redis from 'ioredis';
import { env } from '../src/infrastructure/config/env.js';
import { FlattenAllPositions } from '../src/application/broker/FlattenAllPositions.js';
import { TradeStationBrokerAdapter } from '../src/infrastructure/broker/tradestation/TradeStationBrokerAdapter.js';
import { TradeStationClient } from '../src/infrastructure/broker/tradestation/TradeStationClient.js';
import { RedisTradeContextRepository } from '../src/infrastructure/trade/RedisTradeContextRepository.js';
import { PrometheusMetricsAdapter } from '../src/infrastructure/metrics/PrometheusMetricsAdapter.js';

// Ejecucion manual: cancela entries pendientes + cancela bracket exits + manda
// Market opuesto por la qty agregada de cada (accountId, symbol) con
// posicion abierta. NO borra nada de Redis: el OrderStream del bot (si esta
// corriendo) o CheckOpenTrades (en el proximo tick) van a marcar los ctx
// como closed cuando lleguen los exit fills.
//
// Uso: pnpm tsx --env-file=.env scripts/flatten-all.ts

const missing: string[] = [];
if (!env.REDIS_URL) missing.push('REDIS_URL');
if (!env.TRADESTATION_CLIENT_ID) missing.push('TRADESTATION_CLIENT_ID');
if (!env.TRADESTATION_REFRESH_TOKEN) missing.push('TRADESTATION_REFRESH_TOKEN');
if (!env.TRADESTATION_ACCOUNT_ID) missing.push('TRADESTATION_ACCOUNT_ID');
if (missing.length > 0) {
  console.error(`[flatten-all] missing env vars: ${missing.join(', ')}`);
  process.exit(1);
}

const accountIds = Array.from(
  new Set(
    [
      env.TRADESTATION_ACCOUNT_ID,
      env.TRADESTATION_ACCOUNT_ID_2,
      env.TRADESTATION_ACCOUNT_ID_3,
    ].filter((id): id is string => !!id),
  ),
);
console.log(`[flatten-all] accountIds=${accountIds.join(',')}`);

const redis = new Redis(env.REDIS_URL!, {
  maxRetriesPerRequest: 3,
  lazyConnect: false,
});

const metrics = new PrometheusMetricsAdapter();
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

const flatten = new FlattenAllPositions({
  broker,
  accountIds,
  tradeRepo,
  metrics,
});

try {
  console.log('[flatten-all] running...');
  const t0 = Date.now();
  await flatten.execute();
  console.log(`[flatten-all] done in ${Date.now() - t0}ms`);
} catch (err) {
  console.error('[flatten-all] error:', err);
  process.exitCode = 1;
} finally {
  redis.disconnect();
}
