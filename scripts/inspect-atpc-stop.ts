import Redis from 'ioredis';
import { env } from '../src/infrastructure/config/env.js';
import { LocalIndicatorAdapter } from '../src/infrastructure/indicators/LocalIndicatorAdapter.js';
import { RedisBarRepository } from '../src/infrastructure/marketdata/RedisBarRepository.js';

const redis = new Redis(env.REDIS_URL!);

const keys = await redis.keys('cw:trade:item:*');
const vals = keys.length === 0 ? [] : await redis.mget(...keys);

const seen = new Set<string>();
const atpcCtxs: Array<Record<string, unknown>> = [];
for (const raw of vals) {
  if (!raw) continue;
  try {
    const c = JSON.parse(raw as string);
    if (c.symbol !== 'ATPC') continue;
    if (seen.has(c.bracket?.entryOrderId)) continue;
    seen.add(c.bracket?.entryOrderId);
    atpcCtxs.push(c);
  } catch {
    /* noop */
  }
}

console.log('\nATPC TradeContexts en Redis:');
for (const c of atpcCtxs) {
  const bracket = c.bracket as Record<string, unknown> | undefined;
  console.log({
    model: c.model,
    accountId: c.accountId,
    status: c.status,
    side: c.side,
    entryOrderId: bracket?.entryOrderId,
    stopOrderId: bracket?.stopOrderId,
    entryLimitPrice: c.entryLimitPrice,
    entryFillPrice: c.entryFillPrice,
    stopPrice: c.stopPrice,
    emaTrailPeriod: c.emaTrailPeriod,
    emaTrailBufferBps: c.emaTrailBufferBps,
    session: c.session,
    syntheticExitFired: c.syntheticExitFired,
    evalStart: c.evalStart,
  });
}

const bars = new RedisBarRepository(redis);
const indicators = new LocalIndicatorAdapter({ bars });
const ema18 = await indicators.getEMA({
  symbol: 'ATPC',
  interval: '1min',
  period: 18,
});
console.log('\nEMA(18) M1 ATPC:', ema18);

const last = await bars.get('ATPC', '1min');
console.log('bars cached:', last.length, 'last 3:', last.slice(-3));

const buffer16 = ema18.value * (1 - 16 / 10_000);
const buffer32 = ema18.value * (1 - 32 / 10_000);
console.log('\nStop teórico EMA - 16bps:', Math.round(buffer16 * 100) / 100);
console.log('Stop teórico EMA - 32bps:', Math.round(buffer32 * 100) / 100);

await redis.quit();
