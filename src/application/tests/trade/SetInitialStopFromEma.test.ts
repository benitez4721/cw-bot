import { describe, expect, it, vi } from 'vitest';
import { SetInitialStopFromEma } from '../../../application/trade/SetInitialStopFromEma.js';
import type { BrokerPort } from '../../../domain/broker/BrokerPort.js';
import type { IndicatorPort } from '../../../domain/indicators/IndicatorPort.js';
import type { TradeContextRepository } from '../../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../../domain/trade/TradeTypes.js';

function ctxRth(overrides: Partial<TradeContext> = {}): TradeContext {
  return {
    model: 'HighOfDayAlertEmaTrail',
    accountId: 'SIM1',
    symbol: 'AAPL',
    side: 'BUY',
    entryLimitPrice: 100,
    stopPrice: 92,
    emaTrailPeriod: 18,
    emaTrailBufferBps: 16,
    entryFillPrice: 100,
    entryFillQuantity: 10,
    evalStart: 's',
    evalEnd: 'e',
    bracket: { entryOrderId: 'E1', stopOrderId: 'S1' },
    indicators: {},
    checks: [],
    status: 'active',
    session: 'rth',
    ...overrides,
  };
}

function fakes(ctx: TradeContext | undefined, emaValue = 100) {
  const tradeRepo = {
    getByOrderId: vi.fn(async () => ctx),
    patch: vi.fn(async () => undefined),
    put: vi.fn(),
    getByOrderIds: vi.fn(async () => new Map()),
    listActiveByModel: vi.fn(async () => []),
    listAllActive: vi.fn(async () => []),
  } as unknown as TradeContextRepository & {
    getByOrderId: ReturnType<typeof vi.fn>;
    patch: ReturnType<typeof vi.fn>;
  };
  const broker = {
    replaceStopPrice: vi.fn(async () => undefined),
  } as unknown as BrokerPort & {
    replaceStopPrice: ReturnType<typeof vi.fn>;
  };
  const indicators = {
    getEMA: vi.fn(async () => ({ value: emaValue, timestamp: 't' })),
  } as unknown as IndicatorPort & {
    getEMA: ReturnType<typeof vi.fn>;
  };
  return { tradeRepo, broker, indicators };
}

describe('SetInitialStopFromEma', () => {
  it('happy path: mueve stop a EMA*(1-bps) via replaceStopPrice y patch', async () => {
    // EMA=100, bps=16 → newStop = 100 * (1 - 16/10000) = 99.84.
    // Stop actual 92 → 99.84 mejora → patch.
    const ctx = ctxRth();
    const { tradeRepo, broker, indicators } = fakes(ctx, 100);
    const useCase = new SetInitialStopFromEma({
      tradeRepo,
      broker,
      indicators,
    });

    await useCase.execute({ entryOrderId: 'E1' });

    expect(indicators.getEMA).toHaveBeenCalledWith({
      symbol: 'AAPL',
      interval: '1min',
      period: 18,
    });
    expect(broker.replaceStopPrice).toHaveBeenCalledWith({
      orderId: 'S1',
      stopPrice: 99.84,
      accountId: 'SIM1',
    });
    expect(tradeRepo.patch).toHaveBeenCalledWith('E1', { stopPrice: 99.84 });
  });

  it('skip si ctx no existe (entryOrderId desconocido)', async () => {
    const { tradeRepo, broker, indicators } = fakes(undefined);
    const useCase = new SetInitialStopFromEma({
      tradeRepo,
      broker,
      indicators,
    });

    await useCase.execute({ entryOrderId: 'E1' });

    expect(indicators.getEMA).not.toHaveBeenCalled();
    expect(broker.replaceStopPrice).not.toHaveBeenCalled();
  });

  it('skip si ctx.emaTrailPeriod es undefined (ctx con trail percent)', async () => {
    const ctx = ctxRth({
      emaTrailPeriod: undefined,
      emaTrailBufferBps: undefined,
    });
    const { tradeRepo, broker, indicators } = fakes(ctx);
    const useCase = new SetInitialStopFromEma({
      tradeRepo,
      broker,
      indicators,
    });

    await useCase.execute({ entryOrderId: 'E1' });

    expect(indicators.getEMA).not.toHaveBeenCalled();
    expect(broker.replaceStopPrice).not.toHaveBeenCalled();
  });

  it('skip si ctx.session no es rth (en pre lo maneja MaybeTrailStopAlongEma)', async () => {
    const ctx = ctxRth({ session: 'pre' });
    const { tradeRepo, broker, indicators } = fakes(ctx);
    const useCase = new SetInitialStopFromEma({
      tradeRepo,
      broker,
      indicators,
    });

    await useCase.execute({ entryOrderId: 'E1' });

    expect(broker.replaceStopPrice).not.toHaveBeenCalled();
  });

  it('skip si no hay stopOrderId en el bracket', async () => {
    const ctx = ctxRth({ bracket: { entryOrderId: 'E1' } });
    const { tradeRepo, broker, indicators } = fakes(ctx);
    const useCase = new SetInitialStopFromEma({
      tradeRepo,
      broker,
      indicators,
    });

    await useCase.execute({ entryOrderId: 'E1' });

    expect(broker.replaceStopPrice).not.toHaveBeenCalled();
  });

  it('skip si la EMA no mejora el stop actual (long: candidate <= stopPrice)', async () => {
    // EMA muy baja → candidate < stopPrice actual.
    const ctx = ctxRth({ stopPrice: 110 });
    const { tradeRepo, broker, indicators } = fakes(ctx, 100);
    const useCase = new SetInitialStopFromEma({
      tradeRepo,
      broker,
      indicators,
    });

    await useCase.execute({ entryOrderId: 'E1' });

    expect(broker.replaceStopPrice).not.toHaveBeenCalled();
    expect(tradeRepo.patch).not.toHaveBeenCalled();
  });

  it('replaceStopPrice falla → loggea y no rethrow', async () => {
    const ctx = ctxRth();
    const { tradeRepo, broker, indicators } = fakes(ctx, 100);
    broker.replaceStopPrice = vi.fn(async () => {
      throw new Error('boom');
    });
    const useCase = new SetInitialStopFromEma({
      tradeRepo,
      broker,
      indicators,
    });

    await expect(
      useCase.execute({ entryOrderId: 'E1' }),
    ).resolves.toBeUndefined();
    expect(tradeRepo.patch).not.toHaveBeenCalled();
  });
});
