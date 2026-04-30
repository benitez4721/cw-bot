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
import { registerBrokerRoutes } from './infrastructure/http/brokerRoutes.js';

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

async function main() {
  const server = await createServer();

  server.get('/health', async () => ({ status: 'ok' }));

  const broker = buildBroker();

  registerBrokerRoutes({
    server,
    placeOrder: new PlaceOrder(broker),
    cancelOrder: new CancelOrder(broker),
    replaceOrder: new ReplaceOrder(broker),
    getBalances: new GetBalances(broker),
    getPositions: new GetPositions(broker),
    getOrders: new GetOrders(broker),
    getHistoricalOrders: new GetHistoricalOrders(broker),
  });

  await server.listen({ port: env.PORT, host: env.HOST || '0.0.0.0' });
  console.log(`[cw-bot] Listening on :${env.PORT} — broker=${env.BROKER_PROVIDER}`);
}

main().catch((err) => {
  console.error('[cw-bot] Fatal startup error:', err);
  process.exit(1);
});
