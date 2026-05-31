import Redis from 'ioredis';
import { env } from '../src/infrastructure/config/env.js';

const r = new Redis(env.REDIS_URL!);
const keys = await r.keys('cw:trade:item:*');
const vals = keys.length ? await r.mget(...keys) : [];
for (const raw of vals) {
  if (!raw) continue;
  const c = JSON.parse(raw as string);
  if (c.symbol !== 'OLOX') continue;
  if (c.bracket?.entryOrderId !== '954380097') continue;
  console.log(JSON.stringify(c, null, 2));
  break;
}
await r.quit();
