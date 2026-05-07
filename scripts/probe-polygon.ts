// Smoke test for the PolygonAdapter realtime WS feed. Run with:
//   pnpm tsx --env-file=.env scripts/probe-polygon.ts AAPL
// Optional:
//   PROBE_DURATION_MS (default 3 min) — exit after this long.
// Historical bootstrap is NOT done here — that path uses Twelve Data.
import { PolygonAdapter } from '../src/infrastructure/polygon/PolygonAdapter.js';

const symbol = process.argv[2] || process.env.PROBE_SYMBOL || 'AAPL';
const durationMs = Number(process.env.PROBE_DURATION_MS) || 3 * 60 * 1000;

async function main() {
  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) {
    console.error('POLYGON_API_KEY is required');
    process.exit(1);
  }

  const adapter = new PolygonAdapter({
    apiKey,
    wsUrl: process.env.POLYGON_WS_URL || 'wss://socket.polygon.io/stocks',
  });

  adapter.onConnectionChange((connected) =>
    console.log(`[probe] ws connected=${connected}`),
  );
  adapter.onBar((sym, bar) => console.log(`[probe] AM ${sym}`, bar));

  console.log(`[probe] connecting WS...`);
  await adapter.connect();
  adapter.subscribe(symbol);
  console.log(
    `[probe] subscribed to AM.${symbol}, listening for ${durationMs}ms`,
  );

  setTimeout(() => {
    console.log('[probe] done — disconnecting');
    adapter.disconnect();
    process.exit(0);
  }, durationMs);
}

main().catch((err) => {
  console.error('[probe] fatal', err);
  process.exit(1);
});
