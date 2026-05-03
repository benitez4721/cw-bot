import { beforeEach, describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { RedisWatchlistRepository } from './RedisWatchlistRepository.js';

describe('RedisWatchlistRepository', () => {
  let redis: Redis;
  let repo: RedisWatchlistRepository;

  beforeEach(async () => {
    redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    repo = new RedisWatchlistRepository(redis);
  });

  it('insert + getBySymbol round-trip', async () => {
    await repo.insert({ symbol: 'AAPL', status: 'active', createdAt: 1000 });
    const found = await repo.getBySymbol('AAPL');
    expect(found).toEqual({
      symbol: 'AAPL',
      status: 'active',
      createdAt: 1000,
    });
  });

  it('insert throws when symbol already exists', async () => {
    await repo.insert({ symbol: 'AAPL', status: 'active', createdAt: 1000 });
    await expect(
      repo.insert({ symbol: 'AAPL', status: 'active', createdAt: 2000 }),
    ).rejects.toThrow(/already in watchlist/);
  });

  it('update mutates existing entry', async () => {
    await repo.insert({ symbol: 'AAPL', status: 'active', createdAt: 1000 });
    await repo.update({ symbol: 'AAPL', status: 'stale', createdAt: 1000 });
    const found = await repo.getBySymbol('AAPL');
    expect(found?.status).toBe('stale');
  });

  it('update throws when symbol not found', async () => {
    await expect(
      repo.update({ symbol: 'TSLA', status: 'active', createdAt: 1000 }),
    ).rejects.toThrow(/not in watchlist/);
  });

  it('list returns all entries', async () => {
    await repo.insert({ symbol: 'AAPL', status: 'active', createdAt: 1 });
    await repo.insert({ symbol: 'TSLA', status: 'active', createdAt: 2 });
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
