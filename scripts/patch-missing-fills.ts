import Redis from 'ioredis';
import { env } from '../src/infrastructure/config/env.js';

const TS_CLIENT_ID = env.TRADESTATION_CLIENT_ID!;
const TS_CLIENT_SECRET = env.TRADESTATION_CLIENT_SECRET!;
const TS_REFRESH_TOKEN = env.TRADESTATION_REFRESH_TOKEN!;
const SIGNIN_URL =
  env.TRADESTATION_SIGNIN_URL || 'https://signin.tradestation.com';
const SIM_BASE = 'https://sim-api.tradestation.com';

const ACCOUNTS = [
  env.TRADESTATION_ACCOUNT_ID,
  env.TRADESTATION_ACCOUNT_ID_2,
  env.TRADESTATION_ACCOUNT_ID_3,
].filter((id): id is string => !!id);

interface TsOrder {
  OrderID: string;
  Status: string;
  FilledPrice?: string;
  OrderType: string;
  ConditionalOrders?: { OrderID: string }[];
  Legs?: {
    BuyOrSell: string;
    ExecQuantity?: string;
    QuantityOrdered?: string;
    Symbol?: string;
  }[];
}

interface TradeContext {
  bracket: {
    entryOrderId: string;
    stopOrderId?: string;
    takeProfitOrderId?: string;
    forcedExitOrderId?: string;
  };
  entryFillPrice?: number;
  entryFillQuantity?: number;
  exitFillPrice?: number;
  exitFillQuantity?: number;
  status: string;
  symbol: string;
  model: string;
}

async function getToken(): Promise<string> {
  const res = await fetch(`${SIGNIN_URL}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: TS_CLIENT_ID,
      client_secret: TS_CLIENT_SECRET,
      refresh_token: TS_REFRESH_TOKEN,
    }),
  });
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

async function fetchAllOrders(token: string): Promise<Map<string, TsOrder>> {
  const map = new Map<string, TsOrder>();
  for (const acct of ACCOUNTS) {
    const res = await fetch(
      `${SIM_BASE}/v3/brokerage/accounts/${acct}/orders?since=2026-05-27&pageSize=600`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const data = (await res.json()) as { Orders?: TsOrder[] };
    for (const o of data.Orders ?? []) map.set(o.OrderID, o);
  }
  return map;
}

function filledPrice(o: TsOrder | undefined): number | null {
  if (!o || o.Status !== 'FLL' || !o.FilledPrice) return null;
  return parseFloat(o.FilledPrice);
}

function filledQty(o: TsOrder | undefined): number | null {
  if (!o || o.Status !== 'FLL') return null;
  const leg = o.Legs?.[0];
  if (!leg) return null;
  return parseInt(leg.ExecQuantity ?? leg.QuantityOrdered ?? '0', 10);
}

async function main() {
  const redis = new Redis(env.REDIS_URL!);
  const token = await getToken();
  const tsOrders = await fetchAllOrders(token);

  const keys = await redis.keys('cw:trade:item:*');
  const vals = await redis.mget(...keys);

  const seen = new Set<string>();
  const contexts: TradeContext[] = [];
  for (const raw of vals) {
    if (!raw) continue;
    try {
      const c = JSON.parse(raw) as TradeContext;
      if (!c.bracket?.entryOrderId) continue;
      if (seen.has(c.bracket.entryOrderId)) continue;
      seen.add(c.bracket.entryOrderId);
      contexts.push(c);
    } catch {
      continue;
    }
  }

  let patched = 0;
  let skipped = 0;

  for (const ctx of contexts) {
    const entryId = ctx.bracket.entryOrderId;
    const patch: Record<string, unknown> = {};

    if (!ctx.entryFillPrice) {
      const tsEntry = tsOrders.get(entryId);
      const price = filledPrice(tsEntry);
      const qty = filledQty(tsEntry);
      if (price && qty) {
        patch.entryFillPrice = price;
        patch.entryFillQuantity = qty;
      }
    }

    if (!ctx.exitFillPrice) {
      const exitIds = [
        ctx.bracket.forcedExitOrderId,
        ctx.bracket.stopOrderId,
        ctx.bracket.takeProfitOrderId,
      ].filter((id): id is string => !!id);

      for (const eid of exitIds) {
        const tsExit = tsOrders.get(eid);
        const price = filledPrice(tsExit);
        const qty = filledQty(tsExit);
        if (price && qty) {
          patch.exitFillPrice = price;
          patch.exitFillQuantity = qty;
          break;
        }
      }
    }

    if (ctx.status !== 'closed' && (ctx.exitFillPrice || patch.exitFillPrice)) {
      patch.status = 'closed';
    }

    if (Object.keys(patch).length === 0) {
      skipped++;
      continue;
    }

    const itemKey = `cw:trade:item:${entryId}`;
    const raw = await redis.get(itemKey);
    if (!raw) continue;

    const current = JSON.parse(raw) as Record<string, unknown>;
    const merged = { ...current, ...patch };
    const serialized = JSON.stringify(merged);

    const secondaryIds = [
      ctx.bracket.stopOrderId,
      ctx.bracket.takeProfitOrderId,
      ctx.bracket.forcedExitOrderId,
    ].filter((id): id is string => !!id && id !== entryId);

    const tx = redis.multi().set(itemKey, serialized, 'EX', 7 * 24 * 3600);
    for (const id of secondaryIds) {
      tx.set(`cw:trade:item:${id}`, serialized, 'EX', 7 * 24 * 3600);
    }
    if (patch.status === 'closed') {
      const modelActiveKey = `cw:trade:modelActive:${(current as TradeContext).model}`;
      tx.srem(modelActiveKey, entryId);
    }
    await tx.exec();

    patched++;
    console.log(
      `PATCHED ${ctx.symbol.padEnd(5)} ${entryId} | ` +
        Object.entries(patch)
          .map(([k, v]) => `${k}=${v}`)
          .join(', '),
    );
  }

  console.log(`\nDone. Patched: ${patched}, Skipped (no change): ${skipped}`);
  await redis.quit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
