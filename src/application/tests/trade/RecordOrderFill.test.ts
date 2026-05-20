import { describe, expect, it, vi } from 'vitest';
import { RecordOrderFill } from '../../../application/trade/RecordOrderFill.js';
import type { Order } from '../../../domain/broker/BrokerTypes.js';
import type { TradeContextRepository } from '../../../domain/trade/TradeContextRepository.js';
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

function makeOrder(over: Partial<Order> = {}): Order {
  return {
    id: 'E1',
    symbol: 'AAPL',
    quantity: 100,
    side: 'BUY',
    type: 'Limit',
    status: 'filled',
    filledPrice: 100,
    filledQuantity: 100,
    createdAt: 't',
    ...over,
  };
}

function buildRepo() {
  const put = vi
    .fn<(ctx: TradeContext) => Promise<void>>()
    .mockResolvedValue(undefined);
  const repo = {
    put,
    getByOrderId: vi.fn(),
    getByOrderIds: vi.fn(),
    listActiveByModel: vi.fn(),
    listAllActive: vi.fn(),
  } as unknown as TradeContextRepository;
  return { repo, put };
}

describe('RecordOrderFill', () => {
  it('persiste entryFillPrice y entryFillQuantity en un fill de entry', async () => {
    const { repo, put } = buildRepo();
    const ctx = makeContext();
    const order = makeOrder({
      id: 'E1',
      filledPrice: 100.25,
      filledQuantity: 100,
    });

    await new RecordOrderFill(repo).execute({ ctx, order });

    expect(put).toHaveBeenCalledTimes(1);
    const saved = put.mock.calls[0][0] as TradeContext;
    expect(saved.entryFillPrice).toBe(100.25);
    expect(saved.entryFillQuantity).toBe(100);
    expect(saved.exitFillPrice).toBeUndefined();
  });

  it('persiste exitFillPrice/Quantity y exitLeg=stop en un fill de la pierna stop', async () => {
    const { repo, put } = buildRepo();
    const ctx = makeContext();
    const order = makeOrder({
      id: 'S1',
      filledPrice: 97.5,
      filledQuantity: 100,
    });

    await new RecordOrderFill(repo).execute({ ctx, order });

    const saved = put.mock.calls[0][0] as TradeContext;
    expect(saved.exitFillPrice).toBe(97.5);
    expect(saved.exitFillQuantity).toBe(100);
    expect(saved.exitLeg).toBe('stop');
  });

  it('marca exitLeg=takeProfit en un fill de la pierna TP', async () => {
    const { repo, put } = buildRepo();
    const ctx = makeContext();
    const order = makeOrder({ id: 'T1', filledPrice: 103.0 });

    await new RecordOrderFill(repo).execute({ ctx, order });

    const saved = put.mock.calls[0][0] as TradeContext;
    expect(saved.exitLeg).toBe('takeProfit');
    expect(saved.exitFillPrice).toBe(103.0);
  });

  it('marca exitLeg=forced en un fill del forcedExitOrderId', async () => {
    const { repo, put } = buildRepo();
    const ctx = makeContext({
      bracket: {
        entryOrderId: 'E1',
        stopOrderId: 'S1',
        takeProfitOrderId: 'T1',
        forcedExitOrderId: 'M1',
      },
    });
    const order = makeOrder({ id: 'M1', filledPrice: 99.8 });

    await new RecordOrderFill(repo).execute({ ctx, order });

    const saved = put.mock.calls[0][0] as TradeContext;
    expect(saved.exitLeg).toBe('forced');
    expect(saved.exitFillPrice).toBe(99.8);
  });

  it('no escribe cuando filledPrice viene undefined (ACK/OPN previo al fill)', async () => {
    const { repo, put } = buildRepo();
    const ctx = makeContext();
    const order = makeOrder({
      id: 'E1',
      filledPrice: undefined,
      status: 'open',
    });

    await new RecordOrderFill(repo).execute({ ctx, order });

    expect(put).not.toHaveBeenCalled();
  });

  it('no escribe cuando el orderId no matchea ninguna pierna del bracket', async () => {
    const { repo, put } = buildRepo();
    const ctx = makeContext();
    const order = makeOrder({ id: 'EXTERNO-1', filledPrice: 100 });

    await new RecordOrderFill(repo).execute({ ctx, order });

    expect(put).not.toHaveBeenCalled();
  });

  it('idempotencia: no escribe si los valores ya están persistidos', async () => {
    const { repo, put } = buildRepo();
    const ctx = makeContext({
      entryFillPrice: 100.25,
      entryFillQuantity: 100,
    });
    const order = makeOrder({
      id: 'E1',
      filledPrice: 100.25,
      filledQuantity: 100,
    });

    await new RecordOrderFill(repo).execute({ ctx, order });

    expect(put).not.toHaveBeenCalled();
  });

  it('idempotencia exit: no escribe si exitFillPrice/Quantity/Leg ya coinciden', async () => {
    const { repo, put } = buildRepo();
    const ctx = makeContext({
      exitFillPrice: 97.5,
      exitFillQuantity: 100,
      exitLeg: 'stop',
    });
    const order = makeOrder({
      id: 'S1',
      filledPrice: 97.5,
      filledQuantity: 100,
    });

    await new RecordOrderFill(repo).execute({ ctx, order });

    expect(put).not.toHaveBeenCalled();
  });

  it('preserva campos previos del context al hacer el patch', async () => {
    const { repo, put } = buildRepo();
    const ctx = makeContext({
      breakEvenMoved: true,
      bracket: {
        entryOrderId: 'E1',
        stopOrderId: 'S1',
        takeProfitOrderId: 'T1',
        forcedExitOrderId: 'M1',
      },
    });
    const order = makeOrder({ id: 'E1', filledPrice: 100.25 });

    await new RecordOrderFill(repo).execute({ ctx, order });

    const saved = put.mock.calls[0][0] as TradeContext;
    expect(saved.breakEvenMoved).toBe(true);
    expect(saved.bracket.forcedExitOrderId).toBe('M1');
    expect(saved.entryFillPrice).toBe(100.25);
  });

  it('un fill posterior con qty mayor (partial→final) sobreescribe', async () => {
    const { repo, put } = buildRepo();
    const ctx = makeContext({ entryFillPrice: 100.1, entryFillQuantity: 50 });
    const order = makeOrder({
      id: 'E1',
      filledPrice: 100.2,
      filledQuantity: 100,
    });

    await new RecordOrderFill(repo).execute({ ctx, order });

    const saved = put.mock.calls[0][0] as TradeContext;
    expect(saved.entryFillPrice).toBe(100.2);
    expect(saved.entryFillQuantity).toBe(100);
  });
});
