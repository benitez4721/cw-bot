// Sondea el HTTP stream de orders/positions de TradeStation y vuelca lo que
// llega tal cual durante N segundos. Sirve para verificar empíricamente:
//   - delimitador entre frames (\n)
//   - shape del heartbeat
//   - existencia de StreamStatus: EndSnapshot
//   - frecuencia de heartbeats
//
// Uso:
//   pnpm tsx --env-file=.env scripts/probe-ts-stream.ts orders 15
//   pnpm tsx --env-file=.env scripts/probe-ts-stream.ts positions 15
import { env } from '../src/infrastructure/config/env.js';
import { TradeStationClient } from '../src/infrastructure/tradestation/TradeStationClient.js';

const which = (process.argv[2] ?? 'orders') as 'orders' | 'positions';
const seconds = Number(process.argv[3] ?? 15);

const client = new TradeStationClient({
  clientId: env.TRADESTATION_CLIENT_ID!,
  clientSecret: env.TRADESTATION_CLIENT_SECRET || '',
  refreshToken: env.TRADESTATION_REFRESH_TOKEN!,
  accountId: env.TRADESTATION_ACCOUNT_ID!,
  simBaseUrl: env.TRADESTATION_SIM_URL,
  liveBaseUrl: env.TRADESTATION_LIVE_URL,
  signinUrl: env.TRADESTATION_SIGNIN_URL,
});

const token = await client.getAccessToken();
const account = encodeURIComponent(client.accountId());
const path = `/v3/brokerage/stream/accounts/${account}/${which}`;
const url = client.apiBase() + path;

console.log(`[probe] GET ${url}`);
console.log(`[probe] account=${client.accountId()} duration=${seconds}s`);
console.log('---');

const ctrl = new AbortController();
const timer = setTimeout(() => {
  console.log(`\n--- [probe] timeout reached, aborting ---`);
  ctrl.abort();
}, seconds * 1000);

const startedAt = Date.now();

try {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.tradestation.streams.v3+json',
    },
    signal: ctrl.signal,
  });
  console.log(`[probe] HTTP ${res.status}`);
  console.log(`[probe] content-type: ${res.headers.get('content-type')}`);
  console.log(
    `[probe] transfer-encoding: ${res.headers.get('transfer-encoding')}`,
  );
  console.log('---');

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    console.error(`[probe] error body: ${text}`);
    process.exit(1);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let chunkIdx = 0;
  let frameIdx = 0;
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunkIdx += 1;
    const ts = ((Date.now() - startedAt) / 1000).toFixed(2);
    const text = decoder.decode(value, { stream: true });
    console.log(
      `[chunk #${chunkIdx} t=${ts}s bytes=${value.byteLength}] ${JSON.stringify(text)}`,
    );
    buffer += text;
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf('\n');
      if (line.trim()) {
        frameIdx += 1;
        console.log(`  → frame #${frameIdx}: ${line}`);
      }
    }
  }
} catch (err) {
  if ((err as Error).name === 'AbortError') {
    console.log('[probe] aborted cleanly');
  } else {
    console.error('[probe] error:', err);
  }
} finally {
  clearTimeout(timer);
}
