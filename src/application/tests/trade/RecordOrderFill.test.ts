import { describe, expect, it, vi } from 'vitest';
import { RecordOrderFill } from '../../../application/trade/RecordOrderFill.js';
import type { Order } from '../../../domain/broker/BrokerTypes.js';
import type {
  TradeContextPatch,
  TradeContextRepository,
} from '../../../domain/trade/TradeContextRepository.js';
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
  const patch = vi
    .fn<(entryOrderId: string, partial: TradeContextPatch) => Promise<void>>()
    .mockResolvedValue(undefined);
  const repo = {
    put: vi.fn(),
    patch,
    getByOrderId: vi.fn(),
    getByOrderIds: vi.fn(),
    listActiveByModel: vi.fn(),
    listAllActive: vi.fn(),
  } as unknown as TradeContextRepository;
  return { repo, patch };
}

describe('RecordOrderFill', () => {
  it('persiste entryFillPrice y entryFillQuantity en un fill de entry', async () => {
    const { repo, patch } = buildRepo();
    const ctx = makeContext();
    const order = makeOrder({
      id: 'E1',
      filledPrice: 100.25,
      filledQuantity: 100,
    });

    await new RecordOrderFill(repo).execute({ ctx, order });

    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch.mock.calls[0][0]).toBe('E1');
    expect(patch.mock.calls[0][1]).toEqual({
      entryFillPrice: 100.25,
      entryFillQuantity: 100,
    });
  });

  it('persiste exitFillPrice/Quantity y exitLeg=stop en un fill de la pierna stop', async () => {
    const { repo, patch } = buildRepo();
    const ctx = makeContext();
    const order = makeOrder({
      id: 'S1',
      filledPrice: 97.5,
      filledQuantity: 100,
    });

    await new RecordOrderFill(repo).execute({ ctx, order });

    expect(patch.mock.calls[0][0]).toBe('E1');
    expect(patch.mock.calls[0][1]).toEqual({
      exitFillPrice: 97.5,
      exitFillQuantity: 100,
      exitLeg: 'stop',
      status: 'closed',
    });
  });

  it('marca exitLeg=takeProfit en un fill de la pierna TP', async () => {
    const { repo, patch } = buildRepo();
    const ctx = makeContext();
    const order = makeOrder({ id: 'T1', filledPrice: 103.0 });

    await new RecordOrderFill(repo).execute({ ctx, order });

    expect(patch.mock.calls[0][1].exitLeg).toBe('takeProfit');
    expect(patch.mock.calls[0][1].exitFillPrice).toBe(103.0);
    expect(patch.mock.calls[0][1].status).toBe('closed');
  });

  it('marca exitLeg=forced en un fill del forcedExitOrderId', async () => {
    const { repo, patch } = buildRepo();
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

    expect(patch.mock.calls[0][1].exitLeg).toBe('forced');
    expect(patch.mock.calls[0][1].exitFillPrice).toBe(99.8);
    expect(patch.mock.calls[0][1].status).toBe('closed');
  });

  it('no escribe cuando filledPrice viene undefined (ACK/OPN previo al fill)', async () => {
    const { repo, patch } = buildRepo();
    const ctx = makeContext();
    const order = makeOrder({
      id: 'E1',
      filledPrice: undefined,
      status: 'open',
    });

    await new RecordOrderFill(repo).execute({ ctx, order });

    expect(patch).not.toHaveBeenCalled();
  });

  it('no escribe cuando el orderId no matchea ninguna pierna del bracket', async () => {
    const { repo, patch } = buildRepo();
    const ctx = makeContext();
    const order = makeOrder({ id: 'EXTERNO-1', filledPrice: 100 });

    await new RecordOrderFill(repo).execute({ ctx, order });

    expect(patch).not.toHaveBeenCalled();
  });

  it('idempotencia: no escribe si los valores ya están persistidos', async () => {
    const { repo, patch } = buildRepo();
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

    expect(patch).not.toHaveBeenCalled();
  });

  it('idempotencia exit: no escribe si exitFillPrice/Quantity/Leg ya coinciden', async () => {
    const { repo, patch } = buildRepo();
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

    expect(patch).not.toHaveBeenCalled();
  });

  it('no toca campos ajenos al fill (breakEvenMoved, bracket no aparecen en el patch)', async () => {
    const { repo, patch } = buildRepo();
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

    const partial = patch.mock.calls[0][1];
    expect(partial).toEqual({ entryFillPrice: 100.25, entryFillQuantity: 100 });
    expect('breakEvenMoved' in partial).toBe(false);
    expect('bracket' in partial).toBe(false);
  });

  it('un fill posterior con qty mayor (partial→final) sobreescribe', async () => {
    const { repo, patch } = buildRepo();
    const ctx = makeContext({ entryFillPrice: 100.1, entryFillQuantity: 50 });
    const order = makeOrder({
      id: 'E1',
      filledPrice: 100.2,
      filledQuantity: 100,
    });

    await new RecordOrderFill(repo).execute({ ctx, order });

    expect(patch.mock.calls[0][1]).toEqual({
      entryFillPrice: 100.2,
      entryFillQuantity: 100,
    });
  });
});
