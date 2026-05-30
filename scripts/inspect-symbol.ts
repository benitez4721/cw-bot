import { env } from '../src/infrastructure/config/env.js';
import { TradeStationBrokerAdapter } from '../src/infrastructure/broker/tradestation/TradeStationBrokerAdapter.js';
import { TradeStationClient } from '../src/infrastructure/broker/tradestation/TradeStationClient.js';
import { PrometheusMetricsAdapter } from '../src/infrastructure/metrics/PrometheusMetricsAdapter.js';

// Uso: pnpm tsx --env-file=.env scripts/inspect-symbol.ts SYMBOL

const symbol = process.argv[2];
if (!symbol) {
  console.error('uso: scripts/inspect-symbol.ts SYMBOL');
  process.exit(1);
}

const accountIds = [
  env.TRADESTATION_ACCOUNT_ID,
  env.TRADESTATION_ACCOUNT_ID_2,
  env.TRADESTATION_ACCOUNT_ID_3,
].filter((id): id is string => !!id);

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

for (const accountId of accountIds) {
  const [orders, positions] = await Promise.all([
    broker.getOrders({ symbol, accountId }),
    broker.getPositions({ accountId }),
  ]);
  const symbolPositions = positions.filter((p) => p.symbol === symbol);
  console.log(`\n=== ${accountId} ===`);
  console.log('positions:', JSON.stringify(symbolPositions, null, 2));
  console.log(
    'orders:',
    JSON.stringify(
      orders.map((o) => ({
        id: o.id,
        type: o.type,
        side: o.side,
        status: o.status,
        qty: o.quantity,
        filled: o.filledQuantity,
        limit: o.limitPrice,
        stop: o.stopPrice,
      })),
      null,
      2,
    ),
  );
}
