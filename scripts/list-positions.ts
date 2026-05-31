import { env } from '../src/infrastructure/config/env.js';
import { TradeStationBrokerAdapter } from '../src/infrastructure/broker/tradestation/TradeStationBrokerAdapter.js';
import { TradeStationClient } from '../src/infrastructure/broker/tradestation/TradeStationClient.js';
import { PrometheusMetricsAdapter } from '../src/infrastructure/metrics/PrometheusMetricsAdapter.js';

// Uso: pnpm tsx --env-file=.env scripts/list-positions.ts

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
  const positions = await broker.getPositions({ accountId });
  const open = positions.filter((p) => p.quantity !== 0);
  console.log(`\n=== ${accountId} (${open.length} open) ===`);
  for (const p of open) {
    console.log(
      `  ${p.symbol}\tqty=${p.quantity}\tavg=${p.averagePrice}\tmv=${p.marketValue}\tuPnL=${p.unrealizedPnL}`,
    );
  }
}
