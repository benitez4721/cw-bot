import { describe, expect, it, vi } from 'vitest';
import { FlattenPrePositions } from '../../../application/broker/FlattenPrePositions.js';
import type { PlaceLimitOrder } from '../../../application/broker/PlaceLimitOrder.js';
import type { BrokerPort } from '../../../domain/broker/BrokerPort.js';
import type { Order, Position } from '../../../domain/broker/BrokerTypes.js';
import type { MetricsPort } from '../../../domain/metrics/MetricsPort.js';
import type { TradeContextRepository } from '../../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../../domain/trade/TradeTypes.js';

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

function fakes(opts: {
  contexts: TradeContext[];
  orders?: Order[];
  positions?: Position[];
  placeResult?: {
    orderId: string;
    status: 'open' | 'rejected';
    error?: string;
  };
}) {
  const placeLimitOrder = {
    execute: vi.fn(
      async () =>
        opts.placeResult ?? {
          orderId: 'X-1',
          status: 'open' as const,
        },
    ),
  } as unknown as PlaceLimitOrder & {
    execute: ReturnType<typeof vi.fn>;
  };
  const broker = {
    getOrders: vi.fn(async () => opts.orders ?? []),
    getPositions: vi.fn(async () => opts.positions ?? []),
    getQuote: vi.fn(async () => ({
      symbol: 'AAPL',
      last: 180,
      bid: 179.9,
      ask: 180.1,
      timestamp: 't',
    })),
    cancelOrder: vi.fn(async () => undefined),
  } as unknown as BrokerPort & {
    cancelOrder: ReturnType<typeof vi.fn>;
  };
  const tradeRepo = {
    listAllActive: vi.fn(async () => opts.contexts),
    patch: vi.fn(async () => undefined),
    put: vi.fn(),
    getByOrderId: vi.fn(),
    getByOrderIds: vi.fn(async () => new Map()),
    listActiveByModel: vi.fn(async () => []),
  } as unknown as TradeContextRepository & {
    patch: ReturnType<typeof vi.fn>;
  };
  const metrics = {
    recordFlattenOutcome: vi.fn(),
    recordFlattenFailure: vi.fn(),
  } as unknown as MetricsPort & {
    recordFlattenOutcome: ReturnType<typeof vi.fn>;
    recordFlattenFailure: ReturnType<typeof vi.fn>;
  };
  return { placeLimitOrder, broker, tradeRepo, metrics };
}

describe('FlattenPrePositions', () => {
  it('manda Limit cross-the-spread cuando hay posicion abierta', async () => {
    const ctx = preContext();
    const { placeLimitOrder, broker, tradeRepo, metrics } = fakes({
      contexts: [ctx],
      positions: [
        {
          symbol: 'AAPL',
          accountId: 'SIM1',
          quantity: 100,
          averagePrice: 180,
          marketValue: 18000,
          unrealizedPnL: 0,
        },
      ],
    });
    const useCase = new FlattenPrePositions({
      broker,
      accountIds: ['SIM1'],
      tradeRepo,
      placeLimitOrder,
      metrics,
    });

    await useCase.execute();

    expect(placeLimitOrder.execute).toHaveBeenCalledTimes(1);
    const call = placeLimitOrder.execute.mock.calls[0][0];
    expect(call.symbol).toBe('AAPL');
    expect(call.side).toBe('SELL');
    expect(call.quantity).toBe(100);
    expect(call.duration).toBe('DYP');
    expect(call.route).toBe('ARCA');
    // bid 179.9 * (1 - 5/10000) ≈ 179.81
    expect(call.limitPrice).toBeCloseTo(179.81, 2);

    expect(tradeRepo.patch).toHaveBeenCalledWith('E1', {
      bracket: { forcedExitOrderId: 'X-1' },
    });
    expect(metrics.recordFlattenOutcome).toHaveBeenCalledWith('marketSent');
  });

  it('cancela entries pendientes (no fillados todavia)', async () => {
    const ctx = preContext({ entryFillQuantity: undefined });
    const { placeLimitOrder, broker, tradeRepo, metrics } = fakes({
      contexts: [ctx],
      orders: [
        {
          id: 'E1',
          symbol: 'AAPL',
          quantity: 100,
          side: 'BUY',
          type: 'Limit',
          status: 'open',
          createdAt: 't',
        },
      ],
      positions: [],
    });
    const useCase = new FlattenPrePositions({
      broker,
      accountIds: ['SIM1'],
      tradeRepo,
      placeLimitOrder,
      metrics,
    });

    await useCase.execute();

    expect(broker.cancelOrder).toHaveBeenCalledWith({
      orderId: 'E1',
      accountId: 'SIM1',
    });
    expect(placeLimitOrder.execute).not.toHaveBeenCalled();
    expect(metrics.recordFlattenOutcome).toHaveBeenCalledWith('cancelled');
  });

  it('agrupa multiples ctxs del mismo (account, symbol) en un solo Limit', async () => {
    const ctxA = preContext({ model: 'macd', bracket: { entryOrderId: 'E1' } });
    const ctxB = preContext({
      model: 'super',
      bracket: { entryOrderId: 'E2' },
    });
    const { placeLimitOrder, tradeRepo, broker, metrics } = fakes({
      contexts: [ctxA, ctxB],
      positions: [
        {
          symbol: 'AAPL',
          accountId: 'SIM1',
          quantity: 300, // suma agregada de los dos entries
          averagePrice: 180,
          marketValue: 54000,
          unrealizedPnL: 0,
        },
      ],
    });
    const useCase = new FlattenPrePositions({
      broker,
      accountIds: ['SIM1'],
      tradeRepo,
      placeLimitOrder,
      metrics,
    });

    await useCase.execute();

    expect(placeLimitOrder.execute).toHaveBeenCalledTimes(1);
    expect(placeLimitOrder.execute.mock.calls[0][0].quantity).toBe(300);

    // El mismo forcedExitOrderId va a cada ctx del grupo.
    expect(tradeRepo.patch).toHaveBeenCalledTimes(2);
    const calls = tradeRepo.patch.mock.calls.map((c) => c[0]);
    expect(calls).toContain('E1');
    expect(calls).toContain('E2');
  });

  it('ctx con exit ya disparado (forcedExitOrderId) y posicion abierta: cancela el Limit del re-peg y re-flatea', async () => {
    const ctx = preContext({
      bracket: { entryOrderId: 'E1', forcedExitOrderId: 'X-old' },
    });
    const { placeLimitOrder, broker, tradeRepo, metrics } = fakes({
      contexts: [ctx],
      positions: [
        {
          symbol: 'AAPL',
          accountId: 'SIM1',
          quantity: 100,
          averagePrice: 180,
          marketValue: 18000,
          unrealizedPnL: 0,
        },
      ],
    });
    const useCase = new FlattenPrePositions({
      broker,
      accountIds: ['SIM1'],
      tradeRepo,
      placeLimitOrder,
      metrics,
    });

    await useCase.execute();

    // Cancela el Limit del re-peg antes de mandar el flatten (getOrders fake
    // devuelve [] → waitOrdersTerminal confirma terminal de inmediato).
    expect(broker.cancelOrder).toHaveBeenCalledWith({
      orderId: 'X-old',
      accountId: 'SIM1',
    });
    expect(placeLimitOrder.execute).toHaveBeenCalledTimes(1);
    expect(tradeRepo.patch).toHaveBeenCalledWith('E1', {
      bracket: { forcedExitOrderId: 'X-1' },
    });
  });

  it('ignora ctxs RTH aunque tengan posicion abierta', async () => {
    const ctxRth: TradeContext = {
      ...preContext(),
      session: 'rth',
      bracket: {
        entryOrderId: 'E1',
        stopOrderId: 'S1',
        takeProfitOrderId: 'T1',
      },
    };
    const { placeLimitOrder, broker, tradeRepo, metrics } = fakes({
      contexts: [ctxRth],
      positions: [
        {
          symbol: 'AAPL',
          accountId: 'SIM1',
          quantity: 100,
          averagePrice: 180,
          marketValue: 18000,
          unrealizedPnL: 0,
        },
      ],
    });
    const useCase = new FlattenPrePositions({
      broker,
      accountIds: ['SIM1'],
      tradeRepo,
      placeLimitOrder,
      metrics,
    });

    await useCase.execute();

    expect(placeLimitOrder.execute).not.toHaveBeenCalled();
    expect(tradeRepo.patch).not.toHaveBeenCalled();
  });

  it('si placeLimitOrder rechaza, no persiste forcedExitOrderId', async () => {
    const ctx = preContext();
    const { placeLimitOrder, broker, tradeRepo, metrics } = fakes({
      contexts: [ctx],
      positions: [
        {
          symbol: 'AAPL',
          accountId: 'SIM1',
          quantity: 100,
          averagePrice: 180,
          marketValue: 18000,
          unrealizedPnL: 0,
        },
      ],
      placeResult: { orderId: '', status: 'rejected', error: 'NO_LIQUIDITY' },
    });
    const useCase = new FlattenPrePositions({
      broker,
      accountIds: ['SIM1'],
      tradeRepo,
      placeLimitOrder,
      metrics,
    });

    await useCase.execute();

    expect(placeLimitOrder.execute).toHaveBeenCalled();
    expect(tradeRepo.patch).not.toHaveBeenCalled();
    expect(metrics.recordFlattenFailure).toHaveBeenCalledWith('market');
  });

  it('no llama broker si no hay ctxs pre abiertos', async () => {
    const { placeLimitOrder, broker, tradeRepo, metrics } = fakes({
      contexts: [],
    });
    const useCase = new FlattenPrePositions({
      broker,
      accountIds: ['SIM1'],
      tradeRepo,
      placeLimitOrder,
      metrics,
    });

    await useCase.execute();

    expect(broker.getOrders).not.toHaveBeenCalled();
    expect(placeLimitOrder.execute).not.toHaveBeenCalled();
  });
});
