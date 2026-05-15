import { beforeEach, describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { RedisWatchlistRepository } from '../../watchlist/RedisWatchlistRepository.js';

describe('RedisWatchlistRepository', () => {
  let redis: Redis;
  let repo: RedisWatchlistRepository;

  beforeEach(async () => {
    redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    repo = new RedisWatchlistRepository(redis);
  });

  it('put + getBySymbol round-trip', async () => {
    await repo.put({ symbol: 'AAPL', status: 'active', createdAt: 1000 });
    const found = await repo.getBySymbol('AAPL');
    expect(found).toEqual({
      symbol: 'AAPL',
      status: 'active',
      createdAt: 1000,
    });
  });

  it('put overwrites existing entry', async () => {
    await repo.put({ symbol: 'AAPL', status: 'active', createdAt: 1000 });
    await repo.put({ symbol: 'AAPL', status: 'stale', createdAt: 1000 });
    const found = await repo.getBySymbol('AAPL');
    expect(found?.status).toBe('stale');
  });

  it('list returns all entries', async () => {
    await repo.put({ symbol: 'AAPL', status: 'active', createdAt: 1 });
    await repo.put({ symbol: 'TSLA', status: 'active', createdAt: 2 });
    const items = await repo.list();
    expect(items).toHaveLength(2);
    const symbols = items.map((i) => i.symbol).sort();
    expect(symbols).toEqual(['AAPL', 'TSLA']);
  });

  it('getBySymbol returns undefined when not found', async () => {
    const found = await repo.getBySymbol('NVDA');
    expect(found).toBeUndefined();
  });
});
