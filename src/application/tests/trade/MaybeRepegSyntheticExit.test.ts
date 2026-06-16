import { describe, expect, it, vi } from 'vitest';
import type * as FlattenHelpers from '../../../application/broker/flattenHelpers.js';

// Mockeamos waitOrdersTerminal (que poolea getOrders con sleeps reales) y
// mantenemos crossTheSpread real para verificar el precio de recolocacion.
vi.mock(
  '../../../application/broker/flattenHelpers.js',
  async (importActual) => {
    const actual = await importActual<typeof FlattenHelpers>();
    return { ...actual, waitOrdersTerminal: vi.fn(async () => true) };
  },
);

import { MaybeRepegSyntheticExit } from '../../../application/trade/MaybeRepegSyntheticExit.js';
import { waitOrdersTerminal } from '../../../application/broker/flattenHelpers.js';
import type { PlaceLimitOrder } from '../../../application/broker/PlaceLimitOrder.js';
import type { BrokerPort } from '../../../domain/broker/BrokerPort.js';
import type { Bar } from '../../../domain/marketdata/MarketDataTypes.js';
import type { TradeContextRepository } from '../../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../../domain/trade/TradeTypes.js';

const aBar: Bar = {
  timestamp: '2026-01-15T07:00:00Z',
  open: 100,
  high: 100,
  low: 100,
  close: 100,
  volume: 100,
};

function preCtx(overrides: Partial<TradeContext> = {}): TradeContext {
  return {
    model: 'RunningUp',
    accountId: 'SIM1',
    symbol: 'AAPL',
    side: 'BUY',
    entryLimitPrice: 100,
    stopPrice: 98,
    trailingStopPercent: 2,
    entryFillPrice: 100,
    entryFillQuantity: 100,
    evalStart: 's',
    evalEnd: 'e',
    bracket: {
      entryOrderId: 'E1',
      forcedExitOrderId: 'X1',
      forcedExitLimitPrice: 99.95,
    },
    indicators: {},
    checks: [],
    status: 'active',
    session: 'pre',
    ...overrides,
  };
}

function fakes(contexts: TradeContext[], bid = 100) {
  const placeLimitOrder = {
    execute: vi.fn(async () => ({ orderId: 'X2', status: 'open' as const })),
  } as unknown as PlaceLimitOrder & { execute: ReturnType<typeof vi.fn> };
  const broker = {
    getQuote: vi.fn(async () => ({
      symbol: 'AAPL',
      last: bid,
      bid,
      ask: bid + 0.1,
      timestamp: 't',
    })),
    cancelOrder: vi.fn(async () => undefined),
    getOrders: vi.fn(async () => []),
  } as unknown as BrokerPort & {
    getQuote: ReturnType<typeof vi.fn>;
    cancelOrder: ReturnType<typeof vi.fn>;
  };
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
  return { placeLimitOrder, broker, tradeRepo };
}

describe('MaybeRepegSyntheticExit', () => {
  it('precio sin cambio (cross == forcedExitLimitPrice): no-op', async () => {
    // bid 100 → cross SELL = 100 * 0.9995 = 99.95 = forcedExitLimitPrice actual.
    const { placeLimitOrder, broker, tradeRepo } = fakes([preCtx()], 100);
    const useCase = new MaybeRepegSyntheticExit({
      broker,
      tradeRepo,
      placeLimitOrder,
    });

    await useCase.execute('AAPL', aBar);

    expect(broker.cancelOrder).not.toHaveBeenCalled();
    expect(placeLimitOrder.execute).not.toHaveBeenCalled();
    expect(tradeRepo.patch).not.toHaveBeenCalled();
  });

  it('precio subió: cancela y recoloca el Limit más alto', async () => {
    // bid 102 → cross SELL = round2(102 * 0.9995) = 101.95 > 99.95.
    const { placeLimitOrder, broker, tradeRepo } = fakes([preCtx()], 102);
    const useCase = new MaybeRepegSyntheticExit({
      broker,
      tradeRepo,
      placeLimitOrder,
    });

    await useCase.execute('AAPL', aBar);

    expect(broker.cancelOrder).toHaveBeenCalledWith({
      orderId: 'X1',
      accountId: 'SIM1',
    });
    const call = placeLimitOrder.execute.mock.calls[0][0];
    expect(call.side).toBe('SELL');
    expect(call.quantity).toBe(100);
    expect(call.limitPrice).toBeCloseTo(101.95, 2);
    expect(tradeRepo.patch).toHaveBeenCalledWith('E1', {
      bracket: { forcedExitOrderId: 'X2', forcedExitLimitPrice: 101.95 },
    });
  });

  it('precio bajó: cancela y recoloca el Limit más bajo', async () => {
    // bid 98 → cross SELL = round2(98 * 0.9995) = 97.95 < 99.95.
    const { placeLimitOrder, broker, tradeRepo } = fakes([preCtx()], 98);
    const useCase = new MaybeRepegSyntheticExit({
      broker,
      tradeRepo,
      placeLimitOrder,
    });

    await useCase.execute('AAPL', aBar);

    expect(broker.cancelOrder).toHaveBeenCalled();
    const call = placeLimitOrder.execute.mock.calls[0][0];
    expect(call.limitPrice).toBeCloseTo(97.95, 2);
    expect(tradeRepo.patch).toHaveBeenCalledWith('E1', {
      bracket: { forcedExitOrderId: 'X2', forcedExitLimitPrice: 97.95 },
    });
  });

  it('ignora ctx EMA (sin trailingStopPercent)', async () => {
    const ctx = preCtx({ trailingStopPercent: undefined, emaTrailPeriod: 18 });
    const { placeLimitOrder, broker, tradeRepo } = fakes([ctx], 102);
    const useCase = new MaybeRepegSyntheticExit({
      broker,
      tradeRepo,
      placeLimitOrder,
    });

    await useCase.execute('AAPL', aBar);

    expect(broker.cancelOrder).not.toHaveBeenCalled();
    expect(placeLimitOrder.execute).not.toHaveBeenCalled();
  });

  it('ignora ctx sin exit disparado (forcedExitOrderId undefined)', async () => {
    const ctx = preCtx({
      bracket: { entryOrderId: 'E1' },
    });
    const { placeLimitOrder, broker, tradeRepo } = fakes([ctx], 102);
    const useCase = new MaybeRepegSyntheticExit({
      broker,
      tradeRepo,
      placeLimitOrder,
    });

    await useCase.execute('AAPL', aBar);

    expect(placeLimitOrder.execute).not.toHaveBeenCalled();
  });

  it('si la cancelación no confirma terminal, no recoloca este bar', async () => {
    vi.mocked(waitOrdersTerminal).mockResolvedValueOnce(false);
    const { placeLimitOrder, broker, tradeRepo } = fakes([preCtx()], 102);
    const useCase = new MaybeRepegSyntheticExit({
      broker,
      tradeRepo,
      placeLimitOrder,
    });

    await useCase.execute('AAPL', aBar);

    expect(broker.cancelOrder).toHaveBeenCalled();
    expect(placeLimitOrder.execute).not.toHaveBeenCalled();
    expect(tradeRepo.patch).not.toHaveBeenCalled();
  });

  it('si placeLimitOrder viene rejected, no patchea (reintenta próximo bar)', async () => {
    const { placeLimitOrder, broker, tradeRepo } = fakes([preCtx()], 102);
    placeLimitOrder.execute = vi.fn(async () => ({
      orderId: '',
      status: 'rejected' as const,
      error: 'NO_LIQUIDITY',
    }));
    const useCase = new MaybeRepegSyntheticExit({
      broker,
      tradeRepo,
      placeLimitOrder,
    });

    await useCase.execute('AAPL', aBar);

    expect(tradeRepo.patch).not.toHaveBeenCalled();
  });

  it('getQuote throw → no rompe el loop (reintenta próximo bar)', async () => {
    const { placeLimitOrder, broker, tradeRepo } = fakes([preCtx()], 102);
    broker.getQuote = vi.fn(async () => {
      throw new Error('quote down');
    });
    const useCase = new MaybeRepegSyntheticExit({
      broker,
      tradeRepo,
      placeLimitOrder,
    });

    await expect(useCase.execute('AAPL', aBar)).resolves.toBeUndefined();
    expect(placeLimitOrder.execute).not.toHaveBeenCalled();
  });

  it('multi-ctx mismo símbolo+cuenta: cada uno recoloca por su propia qty', async () => {
    const ctxA = preCtx({
      model: 'CrossOverVwap',
      entryFillQuantity: 100,
      bracket: {
        entryOrderId: 'EA',
        forcedExitOrderId: 'XA',
        forcedExitLimitPrice: 99.95,
      },
    });
    const ctxB = preCtx({
      model: 'RunningUpLowVolume',
      entryFillQuantity: 40,
      bracket: {
        entryOrderId: 'EB',
        forcedExitOrderId: 'XB',
        forcedExitLimitPrice: 99.95,
      },
    });
    const { placeLimitOrder, broker, tradeRepo } = fakes([ctxA, ctxB], 102);
    const useCase = new MaybeRepegSyntheticExit({
      broker,
      tradeRepo,
      placeLimitOrder,
    });

    await useCase.execute('AAPL', aBar);

    const qtys = placeLimitOrder.execute.mock.calls.map((c) => c[0].quantity);
    expect(qtys).toContain(100);
    expect(qtys).toContain(40);
    expect(placeLimitOrder.execute).toHaveBeenCalledTimes(2);
  });
});
