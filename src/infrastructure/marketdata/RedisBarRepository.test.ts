import { beforeEach, describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import type { Bar } from '../../domain/marketdata/MarketDataTypes.js';
import { RedisBarRepository } from './RedisBarRepository.js';

function bar(timestamp: string, close: number, volume = 1000): Bar {
  return { timestamp, open: close, high: close, low: close, close, volume };
}

describe('RedisBarRepository', () => {
  let redis: Redis;
  let repo: RedisBarRepository;

  beforeEach(async () => {
    redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    repo = new RedisBarRepository(redis, { ttlSeconds: 3600 });
  });

  it('returns [] when symbol/interval has no key', async () => {
    expect(await repo.get('AAPL', '1min')).toEqual([]);
    expect(await repo.get('AAPL', '5min')).toEqual([]);
  });

  it('set + get roundtrip preserves bar order', async () => {
    const bars = [
      bar('2026-05-07T13:30:00Z', 100),
      bar('2026-05-07T13:31:00Z', 101),
      bar('2026-05-07T13:32:00Z', 102),
    ];
    await repo.set('AAPL', '1min', bars);
    expect(await repo.get('AAPL', '1min')).toEqual(bars);
  });

  it('keeps 1min and 5min series isolated', async () => {
    const b1 = [bar('2026-05-07T13:30:00Z', 100)];
    const b5 = [bar('2026-05-07T13:30:00Z', 200)];
    await repo.set('AAPL', '1min', b1);
    await repo.set('AAPL', '5min', b5);
    expect(await repo.get('AAPL', '1min')).toEqual(b1);
    expect(await repo.get('AAPL', '5min')).toEqual(b5);
  });

  it('append adds to end of existing series', async () => {
    await repo.set('AAPL', '1min', [bar('2026-05-07T13:30:00Z', 100)]);
    await repo.append('AAPL', '1min', bar('2026-05-07T13:31:00Z', 101));
    const bars = await repo.get('AAPL', '1min');
    expect(bars).toHaveLength(2);
    expect(bars[1].close).toBe(101);
  });

  it('append on missing key creates single-element list', async () => {
    await repo.append('TSLA', '1min', bar('2026-05-07T13:30:00Z', 700));
    const bars = await repo.get('TSLA', '1min');
    expect(bars).toEqual([bar('2026-05-07T13:30:00Z', 700)]);
  });

  it('get with limit returns last N entries', async () => {
    const bars = [
      bar('2026-05-07T13:30:00Z', 100),
      bar('2026-05-07T13:31:00Z', 101),
      bar('2026-05-07T13:32:00Z', 102),
      bar('2026-05-07T13:33:00Z', 103),
    ];
    await repo.set('AAPL', '1min', bars);
    expect(await repo.get('AAPL', '1min', 2)).toEqual(bars.slice(-2));
    expect(await repo.get('AAPL', '1min', 10)).toEqual(bars);
  });

  it('delete removes both 1min and 5min series', async () => {
    await repo.set('AAPL', '1min', [bar('2026-05-07T13:30:00Z', 100)]);
    await repo.set('AAPL', '5min', [bar('2026-05-07T13:30:00Z', 200)]);
    await repo.delete('AAPL');
    expect(await repo.get('AAPL', '1min')).toEqual([]);
    expect(await repo.get('AAPL', '5min')).toEqual([]);
  });

  it('set applies TTL', async () => {
    await repo.set('AAPL', '1min', [bar('2026-05-07T13:30:00Z', 100)]);
    const ttl = await redis.ttl('cw:bars:1m:AAPL');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(3600);
  });

  it('append refreshes TTL', async () => {
    const oneHourRepo = new RedisBarRepository(redis, { ttlSeconds: 3600 });
    await oneHourRepo.set('AAPL', '1min', [bar('2026-05-07T13:30:00Z', 100)]);
    // Manually shorten TTL to simulate aging key
    await redis.expire('cw:bars:1m:AAPL', 5);
    await oneHourRepo.append('AAPL', '1min', bar('2026-05-07T13:31:00Z', 101));
    const ttl = await redis.ttl('cw:bars:1m:AAPL');
    expect(ttl).toBeGreaterThan(5);
  });
});
