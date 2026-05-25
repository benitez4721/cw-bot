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
  // Para simular cancel async: el segundo+ poll a getOrders devuelve este set.
  // Si no se setea, getOrders siempre devuelve `orders` (snapshot inicial).
  ordersAfterCancel?: Order[];
}): Setup {
  const orders = overrides.orders ?? [];
  const positions = overrides.positions ?? [];
  const contexts = overrides.contexts ?? [];

  let getOrdersCalls = 0;
  const broker = {
    getOrders: vi.fn(async () => {
      getOrdersCalls += 1;
      if (getOrdersCalls === 1 || overrides.ordersAfterCancel === undefined) {
        return orders;
      }
      return overrides.ordersAfterCancel;
    }),
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
    patch: vi.fn(async () => undefined),
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
    expect(s.tradeRepo.patch).not.toHaveBeenCalled();
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
    expect(s.tradeRepo.patch).not.toHaveBeenCalled();
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

    // Persiste forcedExitOrderId en el context via patch (no toca status)
    expect(s.tradeRepo.patch).toHaveBeenCalledWith('E1', {
      bracket: { forcedExitOrderId: 'M1' },
    });
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
    expect(s.tradeRepo.patch).toHaveBeenCalledWith('E1', {
      bracket: { forcedExitOrderId: 'M9' },
    });
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
    expect(s.tradeRepo.patch).not.toHaveBeenCalled();
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
    expect(s.tradeRepo.patch).not.toHaveBeenCalled();
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

    // Ambos contexts patcheados con el mismo forcedExitOrderId
    const patchCalls = (
      s.tradeRepo.patch as unknown as ReturnType<typeof vi.fn>
    ).mock.calls;
    expect(patchCalls).toHaveLength(2);
    expect(patchCalls[0]).toEqual([
      'EA',
      { bracket: { forcedExitOrderId: 'M_shared' } },
    ]);
    expect(patchCalls[1]).toEqual([
      'EB',
      { bracket: { forcedExitOrderId: 'M_shared' } },
    ]);
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
    expect(s.tradeRepo.patch).not.toHaveBeenCalled();
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
          // Simula propagación inmediata del cancel — la order desaparece del
          // próximo getOrders, así waitOrdersTerminal confirma sin esperar.
          const bucket = ordersByAccount[input.accountId ?? ''] ?? [];
          ordersByAccount[input.accountId ?? ''] = bucket.filter(
            (o) => o.id !== input.orderId,
          );
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
      patch: vi.fn(async () => undefined),
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

  it('Caso B: NO manda Market mientras las exits siguen activas en getOrders', async () => {
    // Caso real (log del 2026-05-21, GRRR): el DELETE responde OK pero TS aún
    // ve las exits como pendientes en su chequeo de riesgo. Sin el wait, el
    // Market se rechaza con "N remaining on sell orders".
    const ctx = makeContext();

    // Snapshot inicial: exits S1+T1 activas. Tras el cancel, desaparecen.
    let ordersSnapshot: Order[] = [
      makeOrder({ id: 'S1', status: 'open', side: 'SELL', type: 'StopMarket' }),
      makeOrder({ id: 'T1', status: 'open', side: 'SELL', type: 'Limit' }),
    ];
    let cancelCount = 0;

    const placeMarketOrder = vi.fn(
      async (): Promise<OrderResult> => ({ orderId: 'M1', status: 'open' }),
    );

    const broker = {
      getOrders: vi.fn(async () => ordersSnapshot),
      getPositions: vi.fn(async () => [makePosition({ quantity: 100 })]),
      cancelOrder: vi.fn(async () => {
        cancelCount += 1;
        // Aplaza la baja de la order hasta que ambos cancels hayan llegado,
        // simulando la latencia de propagación de TS.
        if (cancelCount >= 2) {
          ordersSnapshot = ordersSnapshot.filter(
            (o) => o.id !== 'S1' && o.id !== 'T1',
          );
        }
      }),
      placeMarketOrder,
    } as unknown as BrokerPort;

    const tradeRepo = {
      listAllActive: vi.fn(async () => [ctx]),
      patch: vi.fn(async () => undefined),
    } as unknown as TradeContextRepository;

    const flatten = new FlattenAllPositions({
      broker,
      accountIds: ['SIM12345'],
      tradeRepo,
      metrics: makeMetrics(),
    });

    await flatten.execute();

    // El Market se mandó UNA vez, después de que ambos cancels limpiaran las
    // exits. cancelOrder se llamó 2 veces (S1+T1).
    expect(broker.cancelOrder).toHaveBeenCalledTimes(2);
    expect(placeMarketOrder).toHaveBeenCalledTimes(1);
    expect(placeMarketOrder).toHaveBeenCalledWith({
      symbol: 'AAPL',
      quantity: 100,
      side: 'SELL',
      accountId: 'SIM12345',
    });
  });

  it('Caso B: si exits no quedan terminales antes del timeout, no manda Market', async () => {
    vi.useFakeTimers();
    try {
      const ctx = makeContext();
      // S1 y T1 permanecen activas — cancel "se pierde" en TS.
      const stuckExits: Order[] = [
        makeOrder({ id: 'S1', status: 'open' }),
        makeOrder({ id: 'T1', status: 'open' }),
      ];

      const placeMarketOrder = vi.fn(
        async (): Promise<OrderResult> => ({ orderId: 'M1', status: 'open' }),
      );

      const broker = {
        getOrders: vi.fn(async () => stuckExits),
        getPositions: vi.fn(async () => [makePosition({ quantity: 100 })]),
        cancelOrder: vi.fn(async () => undefined),
        placeMarketOrder,
      } as unknown as BrokerPort;

      const tradeRepo = {
        listAllActive: vi.fn(async () => [ctx]),
        patch: vi.fn(async () => undefined),
      } as unknown as TradeContextRepository;

      const metrics = makeMetrics();
      const flatten = new FlattenAllPositions({
        broker,
        accountIds: ['SIM12345'],
        tradeRepo,
        metrics,
      });

      const promise = flatten.execute();
      // Avanza más allá del cancelConfirmTimeoutMs (3000ms) para que el
      // wait haga timeout. advanceTimersByTimeAsync flushea microtasks entre
      // ticks así que los await getOrders + sleep iteran.
      await vi.advanceTimersByTimeAsync(3500);
      await promise;

      expect(placeMarketOrder).not.toHaveBeenCalled();
      expect(tradeRepo.patch).not.toHaveBeenCalled();
      expect(metrics.recordFlattenFailure).toHaveBeenCalledWith(
        'cancelTimeout',
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
