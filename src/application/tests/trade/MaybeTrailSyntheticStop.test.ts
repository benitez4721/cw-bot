import { describe, expect, it, vi } from 'vitest';
import { MaybeTrailSyntheticStop } from '../../../application/trade/MaybeTrailSyntheticStop.js';
import type { Bar } from '../../../domain/marketdata/MarketDataTypes.js';
import type { TradeContextRepository } from '../../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../../domain/trade/TradeTypes.js';

function bar(overrides: Partial<Bar> = {}): Bar {
  return {
    timestamp: '2026-01-15T07:00:00Z',
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume: 100,
    ...overrides,
  };
}

function preCtx(overrides: Partial<TradeContext> = {}): TradeContext {
  return {
    model: 'HighOfDayAlert',
    accountId: 'SIM1',
    symbol: 'AAPL',
    side: 'BUY',
    entryLimitPrice: 100,
    stopPrice: 92,
    trailingStopPercent: 8,
    entryFillPrice: 100,
    entryFillQuantity: 10,
    evalStart: 's',
    evalEnd: 'e',
    bracket: { entryOrderId: 'E1' },
    indicators: {},
    checks: [],
    status: 'active',
    session: 'pre',
    syntheticExitFired: false,
    ...overrides,
  };
}

function fakes(contexts: TradeContext[]) {
  const tradeRepo = {
    listAllActive: vi.fn(async () => contexts),
    patch: vi.fn(async () => undefined),
    put: vi.fn(),
    getByOrderId: vi.fn(),
    getByOrderIds: vi.fn(async () => new Map()),
    listActiveByModel: vi.fn(async () => []),
  } as unknown as TradeContextRepository & {
    patch: ReturnType<typeof vi.fn>;
    listAllActive: ReturnType<typeof vi.fn>;
  };
  return { tradeRepo };
}

describe('MaybeTrailSyntheticStop', () => {
  it('long: sube el stop cuando bar.high * (1-tsp%) supera el stop actual', async () => {
    const ctx = preCtx();
    const { tradeRepo } = fakes([ctx]);
    const useCase = new MaybeTrailSyntheticStop({ tradeRepo });

    // bar.high 110 → newStop = 110 * 0.92 = 101.2 > 92 → patch
    await useCase.execute('AAPL', bar({ high: 110, low: 100, close: 105 }));

    expect(tradeRepo.patch).toHaveBeenCalledTimes(1);
    expect(tradeRepo.patch).toHaveBeenCalledWith('E1', { stopPrice: 101.2 });
  });

  it('long: NO patchea cuando el candidato no mejora el stop actual', async () => {
    // Stop actual ya alto (105). bar.high 110 → candidato 101.2 < 105 → no patch.
    const ctx = preCtx({ stopPrice: 105 });
    const { tradeRepo } = fakes([ctx]);
    const useCase = new MaybeTrailSyntheticStop({ tradeRepo });

    await useCase.execute('AAPL', bar({ high: 110, low: 100, close: 105 }));

    expect(tradeRepo.patch).not.toHaveBeenCalled();
  });

  it('long: NO patchea cuando bar.high cae por debajo del high-watermark previo', async () => {
    // Stop actual 101.2 (de un trail anterior). bar.high 105 → candidato
    // 105*0.92=96.6 < 101.2 → no baja el stop.
    const ctx = preCtx({ stopPrice: 101.2 });
    const { tradeRepo } = fakes([ctx]);
    const useCase = new MaybeTrailSyntheticStop({ tradeRepo });

    await useCase.execute('AAPL', bar({ high: 105, low: 95, close: 100 }));

    expect(tradeRepo.patch).not.toHaveBeenCalled();
  });

  it('short: baja el stop cuando bar.low * (1+tsp%) mejora el stop actual', async () => {
    // SELL con stopPrice 108. bar.low 95 → candidato 95*1.08=102.6 < 108 → patch.
    const ctx = preCtx({ side: 'SELL', stopPrice: 108, entryFillPrice: 100 });
    const { tradeRepo } = fakes([ctx]);
    const useCase = new MaybeTrailSyntheticStop({ tradeRepo });

    await useCase.execute('AAPL', bar({ high: 100, low: 95, close: 98 }));

    expect(tradeRepo.patch).toHaveBeenCalledWith('E1', { stopPrice: 102.6 });
  });

  it('NO patchea sin entryFillPrice (entry todavia no llena)', async () => {
    const ctx = preCtx({ entryFillPrice: undefined });
    const { tradeRepo } = fakes([ctx]);
    const useCase = new MaybeTrailSyntheticStop({ tradeRepo });

    await useCase.execute('AAPL', bar({ high: 110 }));

    expect(tradeRepo.patch).not.toHaveBeenCalled();
  });

  it('NO patchea ctx sin trailingStopPercent (DecisionStrategy pre con stop fijo)', async () => {
    const ctx = preCtx({ trailingStopPercent: undefined });
    const { tradeRepo } = fakes([ctx]);
    const useCase = new MaybeTrailSyntheticStop({ tradeRepo });

    await useCase.execute('AAPL', bar({ high: 110 }));

    expect(tradeRepo.patch).not.toHaveBeenCalled();
  });

  it('NO patchea ctx con syntheticExitFired (idempotencia)', async () => {
    const ctx = preCtx({ syntheticExitFired: true });
    const { tradeRepo } = fakes([ctx]);
    const useCase = new MaybeTrailSyntheticStop({ tradeRepo });

    await useCase.execute('AAPL', bar({ high: 110 }));

    expect(tradeRepo.patch).not.toHaveBeenCalled();
  });

  it('ignora ctx RTH aunque coincida con el symbol', async () => {
    const ctx = preCtx({ session: 'rth' });
    const { tradeRepo } = fakes([ctx]);
    const useCase = new MaybeTrailSyntheticStop({ tradeRepo });

    await useCase.execute('AAPL', bar({ high: 110 }));

    expect(tradeRepo.patch).not.toHaveBeenCalled();
  });

  it('ignora ctx de otro symbol', async () => {
    const ctx = preCtx({ symbol: 'TSLA' });
    const { tradeRepo } = fakes([ctx]);
    const useCase = new MaybeTrailSyntheticStop({ tradeRepo });

    await useCase.execute('AAPL', bar({ high: 110 }));

    expect(tradeRepo.patch).not.toHaveBeenCalled();
  });
});
