import { describe, expect, it, vi } from 'vitest';
import { CheckSyntheticStops } from '../../../application/trade/CheckSyntheticStops.js';
import type { ReconcileEntryFill } from '../../../application/trade/ReconcileEntryFill.js';
import type { PlaceLimitOrder } from '../../../application/broker/PlaceLimitOrder.js';
import type { BrokerPort } from '../../../domain/broker/BrokerPort.js';
import type { Bar } from '../../../domain/marketdata/MarketDataTypes.js';
import type { TradeContextRepository } from '../../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../../domain/trade/TradeTypes.js';

function bar(close: number, overrides: Partial<Bar> = {}): Bar {
  return {
    timestamp: '2026-01-15T07:00:00Z',
    open: close,
    high: close,
    low: close,
    close,
    volume: 100,
    ...overrides,
  };
}

function preContext(overrides: Partial<TradeContext> = {}): TradeContext {
  return {
    model: 'macd',
    accountId: 'SIM1',
    symbol: 'AAPL',
    side: 'BUY',
    entryLimitPrice: 180,
    stopPrice: 179,
    takeProfitPrice: 182,
    evalStart: 's',
    evalEnd: 'e',
    bracket: { entryOrderId: 'E1' },
    indicators: {},
    checks: [],
    status: 'active',
    session: 'pre',
    entryFillQuantity: 100,
    ...overrides,
  };
}

function fakes(contexts: TradeContext[]) {
  const placeLimitOrder = {
    execute: vi.fn(async () => ({
      orderId: 'X-1',
      status: 'open' as const,
    })),
  } as unknown as PlaceLimitOrder & {
    execute: ReturnType<typeof vi.fn>;
  };
  const broker = {
    getQuote: vi.fn(async () => ({
      symbol: 'AAPL',
      last: 179,
      bid: 178.9,
      ask: 179.1,
      timestamp: 't',
    })),
  } as unknown as BrokerPort;
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
    getByOrderId: ReturnType<typeof vi.fn>;
  };
  // Por defecto no-op: el ctx ya trae entryFillQuantity, así que ensureEntryFill
  // ni lo invoca. Los tests del self-heal lo overridean.
  const reconcileEntryFill = {
    execute: vi.fn(async () => undefined),
  } as unknown as ReconcileEntryFill & {
    execute: ReturnType<typeof vi.fn>;
  };
  return { placeLimitOrder, broker, tradeRepo, reconcileEntryFill };
}

describe('CheckSyntheticStops', () => {
  it('dispara exit Limit cross-the-spread cuando bar.close toca el stop (long)', async () => {
    const ctx = preContext();
    const { placeLimitOrder, broker, tradeRepo, reconcileEntryFill } = fakes([
      ctx,
    ]);
    const useCase = new CheckSyntheticStops({
      broker,
      tradeRepo,
      placeLimitOrder,
      reconcileEntryFill,
    });

    await useCase.execute('AAPL', bar(178.5));

    expect(placeLimitOrder.execute).toHaveBeenCalledTimes(1);
    const call = placeLimitOrder.execute.mock.calls[0][0];
    expect(call.symbol).toBe('AAPL');
    expect(call.side).toBe('SELL');
    expect(call.quantity).toBe(100);
    expect(call.duration).toBe('DYP');
    expect(call.route).toBe('ARCA');
    // bid 178.9 * (1 - 5/10000) = 178.81 (cross-the-spread 5 bps)
    expect(call.limitPrice).toBeCloseTo(178.81, 2);

    expect(tradeRepo.patch).toHaveBeenCalledWith('E1', {
      bracket: { forcedExitOrderId: 'X-1', forcedExitLimitPrice: 178.81 },
    });
  });

  it('dispara exit cuando bar.close toca el takeProfit (long)', async () => {
    const ctx = preContext();
    const { placeLimitOrder, broker, tradeRepo, reconcileEntryFill } = fakes([
      ctx,
    ]);
    const useCase = new CheckSyntheticStops({
      broker,
      tradeRepo,
      placeLimitOrder,
      reconcileEntryFill,
    });

    await useCase.execute('AAPL', bar(182.5));

    expect(placeLimitOrder.execute).toHaveBeenCalledTimes(1);
    expect(tradeRepo.patch).toHaveBeenCalled();
  });

  it('invierte los triggers en short — close >= stop o close <= TP dispara', async () => {
    const ctx = preContext({
      side: 'SELL',
      entryLimitPrice: 100,
      stopPrice: 101,
      takeProfitPrice: 97,
    });
    const { placeLimitOrder, broker, tradeRepo, reconcileEntryFill } = fakes([
      ctx,
    ]);
    const useCase = new CheckSyntheticStops({
      broker,
      tradeRepo,
      placeLimitOrder,
      reconcileEntryFill,
    });

    await useCase.execute('AAPL', bar(101.5));

    expect(placeLimitOrder.execute).toHaveBeenCalled();
    const call = placeLimitOrder.execute.mock.calls[0][0];
    expect(call.side).toBe('BUY');
  });

  it('no dispara cuando bar.close esta entre stop y TP', async () => {
    const ctx = preContext();
    const { placeLimitOrder, broker, tradeRepo, reconcileEntryFill } = fakes([
      ctx,
    ]);
    const useCase = new CheckSyntheticStops({
      broker,
      tradeRepo,
      placeLimitOrder,
      reconcileEntryFill,
    });

    await useCase.execute('AAPL', bar(180.5));

    expect(placeLimitOrder.execute).not.toHaveBeenCalled();
    expect(tradeRepo.patch).not.toHaveBeenCalled();
  });

  it('skipea ctx con exit ya disparado (forcedExitOrderId) — idempotencia', async () => {
    const ctx = preContext({
      bracket: { entryOrderId: 'E1', forcedExitOrderId: 'X-1' },
    });
    const { placeLimitOrder, broker, tradeRepo, reconcileEntryFill } = fakes([
      ctx,
    ]);
    const useCase = new CheckSyntheticStops({
      broker,
      tradeRepo,
      placeLimitOrder,
      reconcileEntryFill,
    });

    await useCase.execute('AAPL', bar(178.5));

    expect(placeLimitOrder.execute).not.toHaveBeenCalled();
  });

  it('sin entryFillQuantity: reconcilia y, si el broker tampoco tiene fill, skipea', async () => {
    const ctx = preContext({ entryFillQuantity: undefined });
    const { placeLimitOrder, broker, tradeRepo, reconcileEntryFill } = fakes([
      ctx,
    ]);
    // reconcile no encuentra fill: el re-read devuelve el ctx sin fill.
    tradeRepo.getByOrderId = vi.fn(async () => ctx);
    const useCase = new CheckSyntheticStops({
      broker,
      tradeRepo,
      placeLimitOrder,
      reconcileEntryFill,
    });

    await useCase.execute('AAPL', bar(178.5));

    expect(reconcileEntryFill.execute).toHaveBeenCalledWith({ ctx });
    expect(placeLimitOrder.execute).not.toHaveBeenCalled();
    expect(tradeRepo.patch).not.toHaveBeenCalled();
  });

  it('self-heal: sin entryFillQuantity pero el broker ya tiene el fill — reconcilia, re-lee y dispara', async () => {
    const ctx = preContext({ entryFillQuantity: undefined });
    const healed = preContext({ entryFillQuantity: 100 });
    const { placeLimitOrder, broker, tradeRepo, reconcileEntryFill } = fakes([
      ctx,
    ]);
    // Simula que reconcileEntryFill persistió el fill: el re-read ya lo trae.
    tradeRepo.getByOrderId = vi.fn(async () => healed);
    const useCase = new CheckSyntheticStops({
      broker,
      tradeRepo,
      placeLimitOrder,
      reconcileEntryFill,
    });

    await useCase.execute('AAPL', bar(178.5));

    expect(reconcileEntryFill.execute).toHaveBeenCalledWith({ ctx });
    expect(placeLimitOrder.execute).toHaveBeenCalledTimes(1);
    expect(placeLimitOrder.execute.mock.calls[0][0].quantity).toBe(100);
    expect(tradeRepo.patch).toHaveBeenCalledWith('E1', {
      bracket: { forcedExitOrderId: 'X-1', forcedExitLimitPrice: 178.81 },
    });
  });

  it('no persiste forcedExitOrderId si la orden viene rejected — reintenta proximo bar', async () => {
    const ctx = preContext();
    const { placeLimitOrder, broker, tradeRepo, reconcileEntryFill } = fakes([
      ctx,
    ]);
    placeLimitOrder.execute = vi.fn(async () => ({
      orderId: '',
      status: 'rejected' as const,
      error: 'NO_LIQUIDITY',
    }));
    const useCase = new CheckSyntheticStops({
      broker,
      tradeRepo,
      placeLimitOrder,
      reconcileEntryFill,
    });

    await useCase.execute('AAPL', bar(178.5));

    expect(placeLimitOrder.execute).toHaveBeenCalled();
    expect(tradeRepo.patch).not.toHaveBeenCalled();
  });

  it('acepta ctx pre sin takeProfitPrice (alert EventStrategy) y dispara por stop', async () => {
    const ctx = preContext({
      takeProfitPrice: undefined,
      trailingStopPercent: 8,
    });
    const { placeLimitOrder, broker, tradeRepo, reconcileEntryFill } = fakes([
      ctx,
    ]);
    const useCase = new CheckSyntheticStops({
      broker,
      tradeRepo,
      placeLimitOrder,
      reconcileEntryFill,
    });

    await useCase.execute('AAPL', bar(178.5));

    expect(placeLimitOrder.execute).toHaveBeenCalledTimes(1);
    expect(tradeRepo.patch).toHaveBeenCalledWith('E1', {
      bracket: { forcedExitOrderId: 'X-1', forcedExitLimitPrice: 178.81 },
    });
  });

  it('ctx pre sin TP no dispara cuando close esta arriba del stop', async () => {
    const ctx = preContext({
      takeProfitPrice: undefined,
      trailingStopPercent: 8,
    });
    const { placeLimitOrder, broker, tradeRepo, reconcileEntryFill } = fakes([
      ctx,
    ]);
    const useCase = new CheckSyntheticStops({
      broker,
      tradeRepo,
      placeLimitOrder,
      reconcileEntryFill,
    });

    // 500 lejos por arriba del stop 179: en el ctx clasico habria sido TP,
    // pero ahora no hay TP definido — no debe disparar.
    await useCase.execute('AAPL', bar(500));

    expect(placeLimitOrder.execute).not.toHaveBeenCalled();
    expect(tradeRepo.patch).not.toHaveBeenCalled();
  });

  it('ignora ctx RTH aunque coincida con el symbol', async () => {
    const ctxRth: TradeContext = {
      ...preContext(),
      session: 'rth',
      stopPrice: undefined,
      takeProfitPrice: undefined,
      bracket: {
        entryOrderId: 'E1',
        stopOrderId: 'S1',
        takeProfitOrderId: 'T1',
      },
    };
    const { placeLimitOrder, broker, tradeRepo, reconcileEntryFill } = fakes([
      ctxRth,
    ]);
    const useCase = new CheckSyntheticStops({
      broker,
      tradeRepo,
      placeLimitOrder,
      reconcileEntryFill,
    });

    await useCase.execute('AAPL', bar(178.5));

    expect(placeLimitOrder.execute).not.toHaveBeenCalled();
  });
});
