import Redis from 'ioredis';
import { env } from '../src/infrastructure/config/env.js';
import { TradeStationBrokerAdapter } from '../src/infrastructure/broker/tradestation/TradeStationBrokerAdapter.js';
import { TradeStationClient } from '../src/infrastructure/broker/tradestation/TradeStationClient.js';
import { RedisTradeContextRepository } from '../src/infrastructure/trade/RedisTradeContextRepository.js';
import { PrometheusMetricsAdapter } from '../src/infrastructure/metrics/PrometheusMetricsAdapter.js';

// Cierra UN trade puntual: ATPC / HighOfDayAlertEmaTrail / SIM2831368M.
// 1) cancela el stop pending del bracket
// 2) poll hasta que el stop quede en estado terminal
// 3) Market SELL por la qty viva de la posicion
// 4) patchea forcedExitOrderId en el ctx
const TARGET = {
  entryOrderId: '954279516',
  stopOrderId: '954279514',
  symbol: 'ATPC',
  accountId: 'SIM2831368M',
} as const;
const CANCEL_TIMEOUT_MS = 3000;
const CANCEL_POLL_MS = 200;

const metrics = new PrometheusMetricsAdapter();
const client = new TradeStationClient({
  clientId: env.TRADESTATION_CLIENT_ID!,
  clientSecret: env.TRADESTATION_CLIENT_SECRET || '',
  refreshToken: env.TRADESTATION_REFRESH_TOKEN!,
  simBaseUrl: env.TRADESTATION_SIM_URL,
  liveBaseUrl: env.TRADESTATION_LIVE_URL,
  signinUrl: env.TRADESTATION_SIGNIN_URL,
  metrics,
});
const broker = new TradeStationBrokerAdapter({ client });
const redis = new Redis(env.REDIS_URL!, { maxRetriesPerRequest: 3 });
const tradeRepo = new RedisTradeContextRepository(redis);

const [positions, ordersBefore] = await Promise.all([
  broker.getPositions({ accountId: TARGET.accountId }),
  broker.getOrders({ accountId: TARGET.accountId }),
]);
const pos = positions.find(
  (p) => p.symbol === TARGET.symbol && p.quantity !== 0,
);
if (!pos) {
  console.log('no open position for', TARGET);
  redis.disconnect();
  process.exit(0);
}
console.log('position:', pos);
console.log(
  'stop order pre:',
  ordersBefore.find((o) => o.id === TARGET.stopOrderId),
);

console.log('cancelling stop', TARGET.stopOrderId);
await broker.cancelOrder({
  orderId: TARGET.stopOrderId,
  accountId: TARGET.accountId,
});

const deadline = Date.now() + CANCEL_TIMEOUT_MS;
let terminal = false;
while (Date.now() < deadline) {
  const orders = await broker.getOrders({ accountId: TARGET.accountId });
  const stop = orders.find((o) => o.id === TARGET.stopOrderId);
  if (
    !stop ||
    (stop.status !== 'pending' &&
      stop.status !== 'open' &&
      stop.status !== 'partiallyFilled')
  ) {
    terminal = true;
    break;
  }
  await new Promise((r) => setTimeout(r, CANCEL_POLL_MS));
}
if (!terminal) {
  console.error('stop did not reach terminal — aborting to avoid TS reject');
  redis.disconnect();
  process.exit(1);
}
console.log('stop terminal — sending market SELL', pos.quantity);

const result = await broker.placeMarketOrder({
  symbol: TARGET.symbol,
  side: pos.quantity > 0 ? 'SELL' : 'BUY',
  quantity: Math.abs(pos.quantity),
  accountId: TARGET.accountId,
});
console.log('placeMarketOrder result:', result);

if (
  !result.orderId ||
  result.status === 'rejected' ||
  result.status === 'expired'
) {
  console.error('market rejected — position remains open');
  redis.disconnect();
  process.exit(1);
}

await tradeRepo.patch(TARGET.entryOrderId, {
  bracket: { forcedExitOrderId: result.orderId },
});
console.log('forcedExitOrderId persisted on ctx', TARGET.entryOrderId);

redis.disconnect();
