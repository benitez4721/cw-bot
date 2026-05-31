import Redis from 'ioredis';
import { env } from '../src/infrastructure/config/env.js';

// Lista TradeContexts activos sin entryFillPrice o sin exitFillPrice (cuando
// ya cerro). Mismos checks que patch-missing-fills.ts, solo read-only.
const redis = new Redis(env.REDIS_URL!);

const keys = await redis.keys('cw:trade:item:*');
const vals = keys.length === 0 ? [] : await redis.mget(...keys);

const seen = new Set<string>();
type Ctx = {
  symbol: string;
  model: string;
  accountId?: string;
  status: string;
  bracket: {
    entryOrderId: string;
    stopOrderId?: string;
    takeProfitOrderId?: string;
    forcedExitOrderId?: string;
  };
  entryFillPrice?: number;
  exitFillPrice?: number;
  emaTrailPeriod?: number;
  emaTrailBufferBps?: number;
  session?: string;
  syntheticExitFired?: boolean;
};
const ctxs: Ctx[] = [];
for (const raw of vals) {
  if (!raw) continue;
  try {
    const c = JSON.parse(raw as string) as Ctx;
    if (!c.bracket?.entryOrderId) continue;
    if (seen.has(c.bracket.entryOrderId)) continue;
    seen.add(c.bracket.entryOrderId);
    ctxs.push(c);
  } catch {
    /* noop */
  }
}

const activeWithoutEntryFill = ctxs.filter(
  (c) => c.status !== 'closed' && c.entryFillPrice === undefined,
);
const closedWithoutEntryFill = ctxs.filter(
  (c) => c.status === 'closed' && c.entryFillPrice === undefined,
);
const closedWithoutExitFill = ctxs.filter(
  (c) => c.status === 'closed' && c.exitFillPrice === undefined,
);

console.log('\n== ACTIVE w/o entryFillPrice ==');
for (const c of activeWithoutEntryFill) {
  console.log({
    model: c.model,
    accountId: c.accountId,
    symbol: c.symbol,
    entryOrderId: c.bracket.entryOrderId,
    stopOrderId: c.bracket.stopOrderId,
    status: c.status,
    session: c.session,
    emaTrail: c.emaTrailPeriod !== undefined,
  });
}
console.log(`total: ${activeWithoutEntryFill.length}`);

console.log('\n== CLOSED w/o entryFillPrice ==');
for (const c of closedWithoutEntryFill) {
  console.log({
    model: c.model,
    accountId: c.accountId,
    symbol: c.symbol,
    entryOrderId: c.bracket.entryOrderId,
    stopOrderId: c.bracket.stopOrderId,
  });
}
console.log(`total: ${closedWithoutEntryFill.length}`);

console.log('\n== CLOSED w/o exitFillPrice ==');
for (const c of closedWithoutExitFill) {
  console.log({
    model: c.model,
    accountId: c.accountId,
    symbol: c.symbol,
    entryOrderId: c.bracket.entryOrderId,
    forcedExitOrderId: c.bracket.forcedExitOrderId,
    stopOrderId: c.bracket.stopOrderId,
  });
}
console.log(`total: ${closedWithoutExitFill.length}`);

await redis.quit();
