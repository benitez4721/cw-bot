import { describe, expect, it, vi } from 'vitest';
import { RecordTradeContext } from '../../../application/trade/RecordTradeContext.js';
import type { TradeContextRepository } from '../../../domain/trade/TradeContextRepository.js';
import type { DecisionSignal } from '../../../domain/decision/DecisionTypes.js';
import type { TradeContext } from '../../../domain/trade/TradeTypes.js';

type BuySignal = Extract<DecisionSignal<unknown>, { action: 'buy' }>;

function fakeRepo(): TradeContextRepository & {
  put: ReturnType<typeof vi.fn>;
} {
  return {
    put: vi.fn(async () => undefined),
    patch: vi.fn(async () => undefined),
    getByOrderId: vi.fn(async () => undefined),
    getByOrderIds: vi.fn(async () => new Map()),
    listActiveByModel: vi.fn(async () => []),
    listAllActive: vi.fn(async () => []),
  } as unknown as TradeContextRepository & {
    put: ReturnType<typeof vi.fn>;
  };
}

function signal(overrides: Partial<BuySignal> = {}): BuySignal {
  return {
    action: 'buy',
    symbol: 'AAPL',
    side: 'BUY',
    entryLimitPrice: 180,
    quantity: 100,
    stopOffset: 1,
    takeProfitOffset: 2,
    checks: [],
    snapshot: { foo: 'bar' },
    ...overrides,
  };
}

describe('RecordTradeContext — sesion rth', () => {
  it('persiste un TradeContext rth con bracket de 3 orderIds', async () => {
    const repo = fakeRepo();
    const useCase = new RecordTradeContext(repo);

    await useCase.execute({
      session: 'rth',
      model: 'macd',
      accountId: 'SIM1',
      bracket: {
        entryOrderId: 'E1',
        stopOrderId: 'S1',
        takeProfitOrderId: 'T1',
      },
      signal: signal(),
      evalStart: 'start',
      evalEnd: 'end',
    });

    expect(repo.put).toHaveBeenCalledTimes(1);
    const ctx = repo.put.mock.calls[0][0] as TradeContext;
    expect(ctx.session).toBe('rth');
    expect(ctx.bracket).toEqual({
      entryOrderId: 'E1',
      stopOrderId: 'S1',
      takeProfitOrderId: 'T1',
    });
    expect(ctx.stopPrice).toBeUndefined();
    expect(ctx.takeProfitPrice).toBeUndefined();
    expect(ctx.syntheticExitFired).toBeUndefined();
  });

  it('exige bracket.entryOrderId', async () => {
    const repo = fakeRepo();
    const useCase = new RecordTradeContext(repo);

    await expect(
      useCase.execute({
        session: 'rth',
        model: 'macd',
        accountId: 'SIM1',
        bracket: { entryOrderId: '', stopOrderId: 'S1' },
        signal: signal(),
        evalStart: 'start',
        evalEnd: 'end',
      }),
    ).rejects.toThrow(/entryOrderId/);
  });
});

describe('RecordTradeContext — sesion pre', () => {
  it('persiste un TradeContext pre con stopPrice y takeProfitPrice derivados del signal (long)', async () => {
    const repo = fakeRepo();
    const useCase = new RecordTradeContext(repo);

    await useCase.execute({
      session: 'pre',
      model: 'macd',
      accountId: 'SIM1',
      entryOrderId: 'E1',
      signal: signal({
        side: 'BUY',
        entryLimitPrice: 180,
        stopOffset: 1,
        takeProfitOffset: 2,
      }),
      evalStart: 'start',
      evalEnd: 'end',
    });

    const ctx = repo.put.mock.calls[0][0] as TradeContext;
    expect(ctx.session).toBe('pre');
    expect(ctx.bracket).toEqual({ entryOrderId: 'E1' });
    expect(ctx.bracket.stopOrderId).toBeUndefined();
    expect(ctx.stopPrice).toBe(179);
    expect(ctx.takeProfitPrice).toBe(182);
    expect(ctx.syntheticExitFired).toBe(false);
  });

  it('invierte los precios para sesion pre con lado SELL (short)', async () => {
    const repo = fakeRepo();
    const useCase = new RecordTradeContext(repo);

    await useCase.execute({
      session: 'pre',
      model: 'macd',
      accountId: 'SIM1',
      entryOrderId: 'E1',
      signal: signal({
        side: 'SELL',
        entryLimitPrice: 100,
        stopOffset: 1,
        takeProfitOffset: 3,
      }),
      evalStart: 'start',
      evalEnd: 'end',
    });

    const ctx = repo.put.mock.calls[0][0] as TradeContext;
    expect(ctx.stopPrice).toBe(101);
    expect(ctx.takeProfitPrice).toBe(97);
  });

  it('exige entryOrderId en sesion pre', async () => {
    const repo = fakeRepo();
    const useCase = new RecordTradeContext(repo);

    await expect(
      useCase.execute({
        session: 'pre',
        model: 'macd',
        accountId: 'SIM1',
        entryOrderId: '',
        signal: signal(),
        evalStart: 'start',
        evalEnd: 'end',
      }),
    ).rejects.toThrow(/entryOrderId/);
  });
});
