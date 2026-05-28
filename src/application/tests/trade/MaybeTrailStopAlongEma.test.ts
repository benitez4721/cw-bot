import { describe, expect, it, vi } from 'vitest';
import { MaybeTrailStopAlongEma } from '../../../application/trade/MaybeTrailStopAlongEma.js';
import type { BrokerPort } from '../../../domain/broker/BrokerPort.js';
import type { IndicatorPort } from '../../../domain/indicators/IndicatorPort.js';
import type { Bar } from '../../../domain/marketdata/MarketDataTypes.js';
import type { TradeContextRepository } from '../../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../../domain/trade/TradeTypes.js';

function bar(overrides: Partial<Bar> = {}): Bar {
  return {
    timestamp: '2026-01-15T14:30:00Z',
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume: 100,
    ...overrides,
  };
}

function ctxEma(overrides: Partial<TradeContext> = {}): TradeContext {
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

function fakes(contexts: TradeContext[], emaValue = 100) {
  const tradeRepo = {
    listAllActive: vi.fn(async () => contexts),
    patch: vi.fn(async () => undefined),
    put: vi.fn(),
    getByOrderId: vi.fn(),
    getByOrderIds: vi.fn(async () => new Map()),
    listActiveByModel: vi.fn(async () => []),
  } as unknown as TradeContextRepository & {
    listAllActive: ReturnType<typeof vi.fn>;
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

describe('MaybeTrailStopAlongEma', () => {
  it('rth long: sube stop con EMA*(1-bps) — replaceStopPrice + patch', async () => {
    // EMA=110, bps=16 → candidate = 110 * (1 - 16/10000) = 109.824 → round2 = 109.82.
    // stopPrice actual 92 → mejora → patch + replaceStopPrice.
    const ctx = ctxEma();
    const { tradeRepo, broker, indicators } = fakes([ctx], 110);
    const useCase = new MaybeTrailStopAlongEma({
      tradeRepo,
      broker,
      indicators,
    });

    await useCase.execute('AAPL', bar());

    expect(broker.replaceStopPrice).toHaveBeenCalledWith({
      orderId: 'S1',
      stopPrice: 109.82,
      accountId: 'SIM1',
    });
    expect(tradeRepo.patch).toHaveBeenCalledWith('E1', { stopPrice: 109.82 });
  });

  it('pre long: solo patch — no toca el broker (stop sintetico)', async () => {
    // Sesion pre, ctx sin stopOrderId.
    const ctx = ctxEma({
      session: 'pre',
      bracket: { entryOrderId: 'E1' },
    });
    const { tradeRepo, broker, indicators } = fakes([ctx], 110);
    const useCase = new MaybeTrailStopAlongEma({
      tradeRepo,
      broker,
      indicators,
    });

    await useCase.execute('AAPL', bar());

    expect(broker.replaceStopPrice).not.toHaveBeenCalled();
    expect(tradeRepo.patch).toHaveBeenCalledWith('E1', { stopPrice: 109.82 });
  });

  it('long: NO patchea cuando EMA baja y el candidate no mejora el stop actual', async () => {
    // stopPrice actual ya alto (105). EMA=100 → candidate 99.84 < 105 → no patch.
    const ctx = ctxEma({ stopPrice: 105 });
    const { tradeRepo, broker, indicators } = fakes([ctx], 100);
    const useCase = new MaybeTrailStopAlongEma({
      tradeRepo,
      broker,
      indicators,
    });

    await useCase.execute('AAPL', bar());

    expect(broker.replaceStopPrice).not.toHaveBeenCalled();
    expect(tradeRepo.patch).not.toHaveBeenCalled();
  });

  it('short: baja stop con EMA*(1+bps); rejecta cuando empeora', async () => {
    // SELL, stopPrice 110. EMA=100, bps=16 → candidate = 100 * 1.0016 = 100.16.
    // 100.16 < 110 → mejora → patch.
    const ctx = ctxEma({ side: 'SELL', stopPrice: 110, entryFillPrice: 105 });
    const { tradeRepo, broker, indicators } = fakes([ctx], 100);
    const useCase = new MaybeTrailStopAlongEma({
      tradeRepo,
      broker,
      indicators,
    });

    await useCase.execute('AAPL', bar());

    expect(broker.replaceStopPrice).toHaveBeenCalledWith({
      orderId: 'S1',
      stopPrice: 100.16,
      accountId: 'SIM1',
    });
    expect(tradeRepo.patch).toHaveBeenCalledWith('E1', { stopPrice: 100.16 });
  });

  it('ignora ctx con trailMode percent (sin emaTrailPeriod)', async () => {
    const ctx = ctxEma({
      emaTrailPeriod: undefined,
      emaTrailBufferBps: undefined,
      trailingStopPercent: 8,
    });
    const { tradeRepo, broker, indicators } = fakes([ctx], 110);
    const useCase = new MaybeTrailStopAlongEma({
      tradeRepo,
      broker,
      indicators,
    });

    await useCase.execute('AAPL', bar());

    expect(indicators.getEMA).not.toHaveBeenCalled();
    expect(broker.replaceStopPrice).not.toHaveBeenCalled();
    expect(tradeRepo.patch).not.toHaveBeenCalled();
  });

  it('ignora ctx sin entryFillPrice (entry todavia no llena)', async () => {
    const ctx = ctxEma({ entryFillPrice: undefined });
    const { tradeRepo, broker, indicators } = fakes([ctx], 110);
    const useCase = new MaybeTrailStopAlongEma({
      tradeRepo,
      broker,
      indicators,
    });

    await useCase.execute('AAPL', bar());

    expect(indicators.getEMA).not.toHaveBeenCalled();
    expect(broker.replaceStopPrice).not.toHaveBeenCalled();
  });

  it('ignora ctx con syntheticExitFired (idempotencia)', async () => {
    const ctx = ctxEma({ session: 'pre', syntheticExitFired: true });
    const { tradeRepo, broker, indicators } = fakes([ctx], 110);
    const useCase = new MaybeTrailStopAlongEma({
      tradeRepo,
      broker,
      indicators,
    });

    await useCase.execute('AAPL', bar());

    expect(tradeRepo.patch).not.toHaveBeenCalled();
  });

  it('ignora ctx de otro symbol', async () => {
    const ctx = ctxEma({ symbol: 'TSLA' });
    const { tradeRepo, broker, indicators } = fakes([ctx], 110);
    const useCase = new MaybeTrailStopAlongEma({
      tradeRepo,
      broker,
      indicators,
    });

    await useCase.execute('AAPL', bar());

    expect(indicators.getEMA).not.toHaveBeenCalled();
  });

  it('getEMA falla para un ctx → loggea y sigue con el resto', async () => {
    const ctxA = ctxEma({ bracket: { entryOrderId: 'EA', stopOrderId: 'SA' } });
    const ctxB = ctxEma({ bracket: { entryOrderId: 'EB', stopOrderId: 'SB' } });
    const { tradeRepo, broker, indicators } = fakes([ctxA, ctxB], 110);
    let calls = 0;
    indicators.getEMA = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return { value: 110, timestamp: 't' };
    });
    const useCase = new MaybeTrailStopAlongEma({
      tradeRepo,
      broker,
      indicators,
    });

    await useCase.execute('AAPL', bar());

    // El segundo ctx si se procesa.
    expect(broker.replaceStopPrice).toHaveBeenCalledTimes(1);
    expect(broker.replaceStopPrice).toHaveBeenCalledWith({
      orderId: 'SB',
      stopPrice: 109.82,
      accountId: 'SIM1',
    });
  });

  it('replaceStopPrice falla → loggea, no rethrow, sigue procesando', async () => {
    const ctx = ctxEma();
    const { tradeRepo, broker, indicators } = fakes([ctx], 110);
    broker.replaceStopPrice = vi.fn(async () => {
      throw new Error('network');
    });
    const useCase = new MaybeTrailStopAlongEma({
      tradeRepo,
      broker,
      indicators,
    });

    await expect(useCase.execute('AAPL', bar())).resolves.toBeUndefined();
    // patch no se llama porque el throw ocurre antes.
    expect(tradeRepo.patch).not.toHaveBeenCalled();
  });
});
