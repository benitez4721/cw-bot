import { describe, expect, it, vi } from 'vitest';
import { FlattenAllPositions } from '../../../application/broker/FlattenAllPositions.js';
import type { BrokerPort } from '../../../domain/broker/BrokerPort.js';
import type {
  Order,
  OrderResult,
  Position,
} from '../../../domain/broker/BrokerTypes.js';
import type { MetricsPort } from '../../../domain/metrics/MetricsPort.js';
import type { TradeContextRepository } from '../../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../../domain/trade/TradeTypes.js';

function makeContext(over: Partial<TradeContext> = {}): TradeContext {
  return {
    model: 'test-model',
    accountId: 'SIM12345',
    symbol: 'AAPL',
    side: 'BUY',
    entryLimitPrice: 100,
    evalStart: '2026-05-18T15:00:00Z',
    evalEnd: '2026-05-18T15:00:00Z',
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

function makeOrder(over: Partial<Order> = {}): Order {
  return {
    id: 'O1',
    symbol: 'AAPL',
    quantity: 100,
    side: 'BUY',
    type: 'Limit',
    status: 'open',
    createdAt: '2026-05-18T14:00:00Z',
    ...over,
  };
}

function makePosition(over: Partial<Position> = {}): Position {
  return {
    symbol: 'AAPL',
    accountId: 'SIM12345',
    quantity: 100,
    averagePrice: 100,
    marketValue: 10_000,
    unrealizedPnL: 0,
    ...over,
  };
}

function makeMetrics(): MetricsPort {
  return {
    recordDecision: vi.fn(),
    recordTick: vi.fn(),
    recordOrderResult: vi.fn(),
    recordTsRequest: vi.fn(),
    recordOauthRefresh: vi.fn(),
    setWatchlistSize: vi.fn(),
    setScannerConnected: vi.fn(),
    recordBarReceived: vi.fn(),
    recordBarDedupSkip: vi.fn(),
    recordBootstrapFailure: vi.fn(),
    setMarketFeedConnected: vi.fn(),
    recordFlattenOutcome: vi.fn(),
    recordFlattenFailure: vi.fn(),
    recordAlertOutcome: vi.fn(),
  };
}

interface Setup {
  broker: BrokerPort;
  tradeRepo: TradeContextRepository;
  metrics: MetricsPort;
  flatten: FlattenAllPositions;
}

function setup(overrides: {
  orders?: Order[];
  positions?: Position[];
  contexts?: TradeContext[];
  placeMarketResult?: OrderResult;
  placeMarketFn?: BrokerPort['placeMarketOrder'];
}): Setup {
  const orders = overrides.orders ?? [];
  const positions = overrides.positions ?? [];
  const contexts = overrides.contexts ?? [];

  const broker = {
    getOrders: vi.fn(async () => orders),
    getPositions: vi.fn(async () => positions),
    cancelOrder: vi.fn(async () => undefined),
    placeMarketOrder:
      overrides.placeMarketFn ??
      vi.fn(
        async (): Promise<OrderResult> =>
          overrides.placeMarketResult ?? { orderId: 'M1', status: 'open' },
      ),
  } as unknown as BrokerPort;

  const tradeRepo = {
    listAllActive: vi.fn(async () =>
      contexts.filter((c) => c.status === 'active'),
    ),
    put: vi.fn(async () => undefined),
  } as unknown as TradeContextRepository;

  const metrics = makeMetrics();
  const flatten = new FlattenAllPositions({
    broker,
    accountIds: ['SIM12345'],
    tradeRepo,
    metrics,
  });
  return { broker, tradeRepo, metrics, flatten };
}

describe('FlattenAllPositions', () => {
  it('no-op cuando no hay orders ni posiciones ni contexts', async () => {
    const s = setup({});
    await s.flatten.execute();
    expect(s.broker.cancelOrder).not.toHaveBeenCalled();
    expect(s.broker.placeMarketOrder).not.toHaveBeenCalled();
    expect(s.tradeRepo.put).not.toHaveBeenCalled();
  });

  it('Caso A — entry pendiente: cancela entry y no envía Market', async () => {
    const ctx = makeContext();
    const s = setup({
      orders: [makeOrder({ id: 'E1', status: 'open' })],
      positions: [],
      contexts: [ctx],
    });

    await s.flatten.execute();

    expect(s.broker.cancelOrder).toHaveBeenCalledWith({
      orderId: 'E1',
      accountId: 'SIM12345',
    });
    expect(s.broker.placeMarketOrder).not.toHaveBeenCalled();
    expect(s.tradeRepo.put).not.toHaveBeenCalled();
    expect(s.metrics.recordFlattenOutcome).toHaveBeenCalledWith('cancelled');
  });

  it('Caso B (LONG): cancela exits, envía SELL Market y persiste forcedExitOrderId', async () => {
    const ctx = makeContext({ side: 'BUY' });
    const s = setup({
      orders: [],
      positions: [makePosition({ quantity: 100 })],
      contexts: [ctx],
      placeMarketResult: { orderId: 'M1', status: 'open' },
    });

    await s.flatten.execute();

    // Cancela ambos exits del bracket
    expect(s.broker.cancelOrder).toHaveBeenCalledWith({
      orderId: 'S1',
      accountId: 'SIM12345',
    });
    expect(s.broker.cancelOrder).toHaveBeenCalledWith({
      orderId: 'T1',
      accountId: 'SIM12345',
    });

    // Market opuesto a LONG → SELL con qty=100
    expect(s.broker.placeMarketOrder).toHaveBeenCalledWith({
      symbol: 'AAPL',
      quantity: 100,
      side: 'SELL',
      accountId: 'SIM12345',
    });

    // Persiste forcedExitOrderId en el context
    expect(s.tradeRepo.put).toHaveBeenCalledWith(
      expect.objectContaining({
        bracket: expect.objectContaining({ forcedExitOrderId: 'M1' }),
        status: 'active',
      }),
    );
    expect(s.metrics.recordFlattenOutcome).toHaveBeenCalledWith('marketSent');
  });

  it('Caso B (SHORT): manda BUY Market con qty absoluto', async () => {
    const ctx = makeContext({ side: 'SELL' });
    const s = setup({
      orders: [],
      positions: [makePosition({ quantity: -50 })],
      contexts: [ctx],
      placeMarketResult: { orderId: 'M9', status: 'open' },
    });

    await s.flatten.execute();

    expect(s.broker.placeMarketOrder).toHaveBeenCalledWith({
      symbol: 'AAPL',
      quantity: 50,
      side: 'BUY',
      accountId: 'SIM12345',
    });
    expect(s.tradeRepo.put).toHaveBeenCalledWith(
      expect.objectContaining({
        bracket: expect.objectContaining({ forcedExitOrderId: 'M9' }),
      }),
    );
  });

  it('Caso C — sin entry pendiente y sin posición: marca skipped, sin side-effects', async () => {
    const ctx = makeContext();
    const s = setup({
      orders: [], // entry no aparece en open orders → ya llenó
      positions: [], // y no hay posición → bracket ya cerró
      contexts: [ctx],
    });

    await s.flatten.execute();

    expect(s.broker.cancelOrder).not.toHaveBeenCalled();
    expect(s.broker.placeMarketOrder).not.toHaveBeenCalled();
    expect(s.tradeRepo.put).not.toHaveBeenCalled();
    expect(s.metrics.recordFlattenOutcome).toHaveBeenCalledWith('skipped');
  });

  it('placeMarketOrder rejected: no persiste forcedExitOrderId y cuenta failure', async () => {
    const ctx = makeContext();
    const s = setup({
      orders: [],
      positions: [makePosition({ quantity: 100 })],
      contexts: [ctx],
      placeMarketResult: {
        orderId: '',
        status: 'rejected',
        error: 'NO_LIQUIDITY',
      },
    });

    await s.flatten.execute();

    expect(s.broker.placeMarketOrder).toHaveBeenCalled();
    expect(s.tradeRepo.put).not.toHaveBeenCalled();
    expect(s.metrics.recordFlattenFailure).toHaveBeenCalledWith('market');
  });

  it('Multi-context mismo símbolo: un único Market y propaga forcedExitOrderId a cada ctx', async () => {
    const ctxA = makeContext({
      model: 'modelA',
      bracket: {
        entryOrderId: 'EA',
        stopOrderId: 'SA',
        takeProfitOrderId: 'TA',
      },
    });
    const ctxB = makeContext({
      model: 'modelB',
      bracket: {
        entryOrderId: 'EB',
        stopOrderId: 'SB',
        takeProfitOrderId: 'TB',
      },
    });
    const placeMarketOrder = vi.fn(
      async (): Promise<OrderResult> => ({
        orderId: 'M_shared',
        status: 'open',
      }),
    );

    const s = setup({
      orders: [],
      positions: [makePosition({ quantity: 200 })], // qty agregada de los 2 brackets
      contexts: [ctxA, ctxB],
      placeMarketFn: placeMarketOrder,
    });

    await s.flatten.execute();

    expect(placeMarketOrder).toHaveBeenCalledTimes(1);
    expect(placeMarketOrder).toHaveBeenCalledWith({
      symbol: 'AAPL',
      quantity: 200,
      side: 'SELL',
      accountId: 'SIM12345',
    });

    // Ambos contexts persistidos con el mismo forcedExitOrderId
    const putCalls = (s.tradeRepo.put as unknown as ReturnType<typeof vi.fn>)
      .mock.calls;
    expect(putCalls).toHaveLength(2);
    expect(putCalls[0][0]).toMatchObject({
      bracket: {
        entryOrderId: 'EA',
        forcedExitOrderId: 'M_shared',
      },
    });
    expect(putCalls[1][0]).toMatchObject({
      bracket: {
        entryOrderId: 'EB',
        forcedExitOrderId: 'M_shared',
      },
    });
  });

  it('Cross-symbol procesa cada símbolo de forma independiente', async () => {
    const ctxAapl = makeContext({ symbol: 'AAPL' });
    const ctxMsft = makeContext({
      symbol: 'MSFT',
      bracket: {
        entryOrderId: 'E2',
        stopOrderId: 'S2',
        takeProfitOrderId: 'T2',
      },
    });

    const placeMarketOrder = vi
      .fn<BrokerPort['placeMarketOrder']>()
      .mockImplementationOnce(async () => ({
        orderId: 'M_AAPL',
        status: 'open',
      }))
      .mockImplementationOnce(async () => ({
        orderId: 'M_MSFT',
        status: 'open',
      }));

    const s = setup({
      orders: [],
      positions: [
        makePosition({ symbol: 'AAPL', quantity: 100 }),
        makePosition({ symbol: 'MSFT', quantity: 50 }),
      ],
      contexts: [ctxAapl, ctxMsft],
      placeMarketFn: placeMarketOrder,
    });

    await s.flatten.execute();

    expect(placeMarketOrder).toHaveBeenCalledTimes(2);
    const symbolsCalled = placeMarketOrder.mock.calls
      .map((c) => c[0].symbol)
      .sort();
    expect(symbolsCalled).toEqual(['AAPL', 'MSFT']);
  });

  it('Ignora contexts con status closed', async () => {
    const ctx = makeContext({ status: 'closed' });
    const s = setup({
      orders: [makeOrder({ id: 'E1', status: 'open' })],
      positions: [makePosition({ quantity: 100 })],
      contexts: [ctx],
    });

    await s.flatten.execute();

    expect(s.broker.cancelOrder).not.toHaveBeenCalled();
    expect(s.broker.placeMarketOrder).not.toHaveBeenCalled();
    expect(s.tradeRepo.put).not.toHaveBeenCalled();
  });

  it('cross-account: dos AAPL en accounts distintos se cierran independientes', async () => {
    // Dos contexts con mismo símbolo en accounts distintos. Cada account
    // tiene su propia posición de AAPL y debe recibir su propio Market —
    // si se confundieran, uno se cerraría con la qty del otro.
    const ctxA = makeContext({
      model: 'A',
      accountId: 'SIM-A',
      bracket: {
        entryOrderId: 'E-A',
        stopOrderId: 'S-A',
        takeProfitOrderId: 'T-A',
      },
    });
    const ctxB = makeContext({
      model: 'B',
      accountId: 'SIM-B',
      bracket: {
        entryOrderId: 'E-B',
        stopOrderId: 'S-B',
        takeProfitOrderId: 'T-B',
      },
    });

    // Tracking por accountId de lo que devuelve el broker.
    const ordersByAccount: Record<string, Order[]> = {
      'SIM-A': [
        makeOrder({ id: 'E-A', status: 'filled' }),
        makeOrder({ id: 'S-A', status: 'open' }),
        makeOrder({ id: 'T-A', status: 'open' }),
      ],
      'SIM-B': [
        makeOrder({ id: 'E-B', status: 'filled' }),
        makeOrder({ id: 'S-B', status: 'open' }),
        makeOrder({ id: 'T-B', status: 'open' }),
      ],
    };
    const positionsByAccount: Record<string, Position[]> = {
      'SIM-A': [
        makePosition({ symbol: 'AAPL', accountId: 'SIM-A', quantity: 100 }),
      ],
      'SIM-B': [
        makePosition({ symbol: 'AAPL', accountId: 'SIM-B', quantity: 250 }),
      ],
    };

    const marketCalls: Array<{
      accountId: string | undefined;
      qty: number;
    }> = [];
    const cancelCalls: Array<{
      orderId: string;
      accountId: string | undefined;
    }> = [];

    const broker = {
      getOrders: vi.fn(async (input: { accountId?: string }) => {
        return ordersByAccount[input.accountId ?? ''] ?? [];
      }),
      getPositions: vi.fn(async (input?: { accountId?: string }) => {
        return positionsByAccount[input?.accountId ?? ''] ?? [];
      }),
      cancelOrder: vi.fn(
        async (input: { orderId: string; accountId?: string }) => {
          cancelCalls.push({
            orderId: input.orderId,
            accountId: input.accountId,
          });
        },
      ),
      placeMarketOrder: vi.fn(
        async (input: {
          symbol: string;
          quantity: number;
          accountId?: string;
        }): Promise<OrderResult> => {
          marketCalls.push({
            accountId: input.accountId,
            qty: input.quantity,
          });
          return {
            orderId: `M-${input.accountId}`,
            status: 'open',
          };
        },
      ),
    } as unknown as BrokerPort;

    const tradeRepo = {
      listAllActive: vi.fn(async () => [ctxA, ctxB]),
      put: vi.fn(async () => undefined),
    } as unknown as TradeContextRepository;

    const flatten = new FlattenAllPositions({
      broker,
      accountIds: ['SIM-A', 'SIM-B'],
      tradeRepo,
      metrics: makeMetrics(),
    });

    await flatten.execute();

    // Cada cuenta envió un Market con su qty (no se confundieron).
    expect(
      marketCalls.sort((a, b) =>
        (a.accountId ?? '').localeCompare(b.accountId ?? ''),
      ),
    ).toEqual([
      { accountId: 'SIM-A', qty: 100 },
      { accountId: 'SIM-B', qty: 250 },
    ]);

    // Cada exit cancelado fue contra su accountId correcto.
    const cancelsByAccount = new Map<string, string[]>();
    for (const c of cancelCalls) {
      const bucket = cancelsByAccount.get(c.accountId ?? '') ?? [];
      bucket.push(c.orderId);
      cancelsByAccount.set(c.accountId ?? '', bucket);
    }
    expect(cancelsByAccount.get('SIM-A')?.sort()).toEqual(['S-A', 'T-A']);
    expect(cancelsByAccount.get('SIM-B')?.sort()).toEqual(['S-B', 'T-B']);
  });
});
