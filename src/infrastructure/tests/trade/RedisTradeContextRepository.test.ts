import { beforeEach, describe, expect, it } from 'vitest';
import RedisMock from 'ioredis-mock';
import type Redis from 'ioredis';
import { RedisTradeContextRepository } from '../../trade/RedisTradeContextRepository.js';
import type { TradeContext } from '../../../domain/trade/TradeTypes.js';

function makeContext(over: Partial<TradeContext> = {}): TradeContext {
  return {
    model: 'm',
    symbol: 'AAPL',
    side: 'BUY',
    entryLimitPrice: 100,
    evalStart: 't0',
    evalEnd: 't1',
    bracket: {
      entryOrderId: 'E1',
      stopOrderId: 'S1',
      takeProfitOrderId: 'T1',
    },
    indicators: null,
    checks: [],
    status: 'active',
    ...over,
  };
}

describe('RedisTradeContextRepository', () => {
  let redis: Redis;
  let repo: RedisTradeContextRepository;

  beforeEach(async () => {
    redis = new RedisMock() as unknown as Redis;
    await redis.flushall();
    repo = new RedisTradeContextRepository(redis);
  });

  it('getByOrderId(entryOrderId) lo encuentra tras put', async () => {
    const ctx = makeContext();
    await repo.put(ctx);
    expect((await repo.getByOrderId('E1'))?.bracket.entryOrderId).toBe('E1');
  });

  it('sin forcedExitOrderId, lookup por un OrderID arbitrario devuelve undefined', async () => {
    const ctx = makeContext();
    await repo.put(ctx);
    expect(await repo.getByOrderId('M1')).toBeUndefined();
  });

  it('con forcedExitOrderId, lookup por ese OrderID devuelve el mismo context', async () => {
    const base = makeContext();
    const ctx: TradeContext = {
      ...base,
      bracket: { ...base.bracket, forcedExitOrderId: 'M1' },
    };
    await repo.put(ctx);
    const byEntry = await repo.getByOrderId('E1');
    const byMarket = await repo.getByOrderId('M1');
    expect(byEntry).toEqual(byMarket);
    expect(byMarket?.bracket.forcedExitOrderId).toBe('M1');
  });

  it('un update posterior con forcedExitOrderId indexa el nuevo OrderID sin perder el entry', async () => {
    const ctx = makeContext();
    await repo.put(ctx);
    expect(await repo.getByOrderId('M1')).toBeUndefined();

    await repo.put({
      ...ctx,
      bracket: { ...ctx.bracket, forcedExitOrderId: 'M1' },
    });
    expect((await repo.getByOrderId('E1'))?.bracket.forcedExitOrderId).toBe(
      'M1',
    );
    expect((await repo.getByOrderId('M1'))?.bracket.entryOrderId).toBe('E1');
  });

  it('listActiveByModel devuelve todos los trades activos del modelo (cross-symbol)', async () => {
    await repo.put(
      makeContext({
        model: 'HighOfDayAlert',
        symbol: 'AAPL',
        bracket: { entryOrderId: 'E-AAPL', stopOrderId: 'S-AAPL' },
      }),
    );
    await repo.put(
      makeContext({
        model: 'HighOfDayAlert',
        symbol: 'MSFT',
        bracket: { entryOrderId: 'E-MSFT', stopOrderId: 'S-MSFT' },
      }),
    );
    await repo.put(
      makeContext({
        model: 'OtroModelo',
        symbol: 'NVDA',
        bracket: { entryOrderId: 'E-NVDA', stopOrderId: 'S-NVDA' },
      }),
    );

    const hodTrades = await repo.listActiveByModel('HighOfDayAlert');
    expect(hodTrades.map((c) => c.symbol).sort()).toEqual(['AAPL', 'MSFT']);
  });

  it('listActiveByModel excluye trades cerrados', async () => {
    await repo.put(
      makeContext({
        model: 'HighOfDayAlert',
        symbol: 'AAPL',
        bracket: { entryOrderId: 'E-A', stopOrderId: 'S-A' },
      }),
    );
    await repo.put(
      makeContext({
        model: 'HighOfDayAlert',
        symbol: 'AAPL',
        status: 'closed',
        bracket: { entryOrderId: 'E-A', stopOrderId: 'S-A' },
      }),
    );

    expect(await repo.listActiveByModel('HighOfDayAlert')).toHaveLength(0);
  });

  it('listActiveByModel devuelve [] cuando no hay trades del modelo', async () => {
    await repo.put(
      makeContext({
        model: 'OtroModelo',
        bracket: { entryOrderId: 'E-X', stopOrderId: 'S-X' },
      }),
    );
    expect(await repo.listActiveByModel('HighOfDayAlert')).toEqual([]);
  });
});
