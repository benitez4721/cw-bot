import { describe, expect, it } from 'vitest';
import type { Order } from '../../../domain/broker/BrokerTypes.js';
import type {
  OrderEvent,
  OrderStreamHandler,
  StreamConnectionHandler,
} from '../../../domain/broker/BrokerStreamTypes.js';
import type { OrderStreamPort } from '../../../domain/broker/OrderStreamPort.js';
import type { TradeContextRepository } from '../../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../../domain/trade/TradeTypes.js';
import { OrderStreamManager } from '../../orderstream/OrderStreamManager.js';
import { RecordOrderFill } from '../../trade/RecordOrderFill.js';

class FakeOrderStream implements OrderStreamPort {
  private orderHandlers: OrderStreamHandler[] = [];
  private connectionHandlers: StreamConnectionHandler[] = [];
  connected = 0;

  async connect(): Promise<void> {
    this.connected++;
    for (const h of this.connectionHandlers) h(true);
  }
  disconnect(): void {
    for (const h of this.connectionHandlers) h(false);
  }
  onOrder(h: OrderStreamHandler): void {
    this.orderHandlers.push(h);
  }
  onConnectionChange(h: StreamConnectionHandler): void {
    this.connectionHandlers.push(h);
  }
  emit(event: OrderEvent): void {
    for (const h of this.orderHandlers) h(event);
  }
  emitConnection(connected: boolean): void {
    for (const h of this.connectionHandlers) h(connected);
  }
}

class FakeTradeContextRepository implements TradeContextRepository {
  private readonly store = new Map<string, TradeContext>();

  setContext(orderId: string, ctx: TradeContext): void {
    this.store.set(orderId, ctx);
  }

  // Mirror del dual-write de RedisTradeContextRepository: indexa el ctx bajo
  // entry + stop + tp + forced para que getByOrderId pueda enriquecer eventos
  // de cualquier pierna del bracket.
  async put(ctx: TradeContext): Promise<void> {
    const ids = [
      ctx.bracket.entryOrderId,
      ctx.bracket.stopOrderId,
      ctx.bracket.takeProfitOrderId,
      ctx.bracket.forcedExitOrderId,
    ].filter((id): id is string => !!id);
    for (const id of ids) this.store.set(id, ctx);
  }
  async patch(
    entryOrderId: string,
    partial: Partial<TradeContext> & {
      bracket?: Partial<TradeContext['bracket']>;
    },
  ): Promise<void> {
    const current = this.store.get(entryOrderId);
    if (!current) return;
    const merged: TradeContext = {
      ...current,
      ...partial,
      bracket: { ...current.bracket, ...(partial.bracket ?? {}) },
    };
    await this.put(merged);
  }
  async getByOrderId(orderId: string): Promise<TradeContext | undefined> {
    return this.store.get(orderId);
  }
  async getByOrderIds(orderIds: string[]): Promise<Map<string, TradeContext>> {
    const out = new Map<string, TradeContext>();
    for (const id of orderIds) {
      const ctx = this.store.get(id);
      if (ctx) out.set(id, ctx);
    }
    return out;
  }
  async listActiveByModel(): Promise<TradeContext[]> {
    return [];
  }
  async listAllActive(): Promise<TradeContext[]> {
    return [];
  }
}

function order(overrides: Partial<Order> = {}): Order {
  return {
    id: 'O-1',
    symbol: 'AAPL',
    quantity: 100,
    side: 'BUY',
    type: 'Limit',
    status: 'open',
    createdAt: '2026-05-10T18:00:00Z',
    ...overrides,
  };
}

function makeEvent(o: Order, origin: 'priorState' | 'liveUpdate'): OrderEvent {
  return {
    order: o,
    accountId: 'SIM12345',
    observedAt: '2026-05-10T18:00:00Z',
    origin,
  };
}

function makeContext(overrides: Partial<TradeContext> = {}): TradeContext {
  return {
    model: 'macd-m1',
    symbol: 'AAPL',
    side: 'BUY',
    entryLimitPrice: 187,
    evalStart: '2026-05-10T17:59:00Z',
    evalEnd: '2026-05-10T18:00:00Z',
    bracket: {
      entryOrderId: 'O-1',
      stopOrderId: 'O-2',
      takeProfitOrderId: 'O-3',
    },
    indicators: { ema9: 187.1, rsi: 62 },
    checks: [],
    status: 'active',
    ...overrides,
  };
}

function buildManager(): {
  stream: FakeOrderStream;
  repo: FakeTradeContextRepository;
  mgr: OrderStreamManager;
} {
  const stream = new FakeOrderStream();
  const repo = new FakeTradeContextRepository();
  const recordOrderFill = new RecordOrderFill(repo);
  const mgr = new OrderStreamManager({
    stream,
    accountId: 'SIM12345',
    tradeRepo: repo,
    recordOrderFill,
    now: () => '2026-05-10T18:01:00Z',
  });
  return { stream, repo, mgr };
}

describe('OrderStreamManager', () => {
  it('replays the current snapshot on subscribe', async () => {
    const { stream, mgr } = buildManager();
    stream.emit(makeEvent(order({ id: 'A' }), 'priorState'));
    stream.emit(makeEvent(order({ id: 'B' }), 'priorState'));
    await mgr.idle();

    const received: OrderEvent[] = [];
    await mgr.subscribe((e) => received.push(e));

    expect(received.map((e) => e.order.id)).toEqual(['A', 'B']);
    expect(received.every((e) => e.origin === 'priorState')).toBe(true);
    expect(received[0]?.observedAt).toBe('2026-05-10T18:01:00Z');
  });

  it('enriches events with TradeContext when the repo has one', async () => {
    const { stream, repo, mgr } = buildManager();
    const ctx = makeContext({
      bracket: { entryOrderId: 'A', stopOrderId: 'B', takeProfitOrderId: 'C' },
    });
    repo.setContext('A', ctx);

    const live: OrderEvent[] = [];
    await mgr.subscribe((e) => live.push(e));

    stream.emit(makeEvent(order({ id: 'A' }), 'liveUpdate'));
    stream.emit(makeEvent(order({ id: 'B' }), 'liveUpdate'));
    await mgr.idle();

    expect(live).toHaveLength(2);
    expect(live[0]?.order.id).toBe('A');
    expect(live[0]?.order.context).toEqual(ctx);
    // B no es entry order; el repo no devuelve contexto y la orden viaja sin él.
    expect(live[1]?.order.id).toBe('B');
    expect(live[1]?.order.context).toBeUndefined();
  });

  it('includes context in the snapshot replay for late subscribers', async () => {
    const { stream, repo, mgr } = buildManager();
    const ctx = makeContext({
      bracket: { entryOrderId: 'A', stopOrderId: 'X', takeProfitOrderId: 'Y' },
    });
    repo.setContext('A', ctx);

    stream.emit(makeEvent(order({ id: 'A', status: 'filled' }), 'priorState'));
    await mgr.idle();

    const replayed: OrderEvent[] = [];
    await mgr.subscribe((e) => replayed.push(e));
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.order.context).toEqual(ctx);
    expect(replayed[0]?.origin).toBe('priorState');
  });

  it('refreshes context from repo on subscribe when cache was missing it', async () => {
    // Race real: el WS update llega antes de que RecordTradeContext escriba
    // en Redis, quedando la orden cacheada sin context. Al subscribirse más
    // tarde, el manager debe re-consultar y enriquecer antes del replay.
    const { stream, repo, mgr } = buildManager();
    stream.emit(makeEvent(order({ id: 'A', status: 'filled' }), 'liveUpdate'));
    await mgr.idle();
    // Recién ahora aparece el contexto en el repo (escritura post-fill).
    const ctx = makeContext({
      bracket: { entryOrderId: 'A', stopOrderId: 'B', takeProfitOrderId: 'C' },
    });
    repo.setContext('A', ctx);
    // El cache aún tiene la orden sin context.
    expect(mgr.getSnapshot()[0]?.context).toBeUndefined();

    const replayed: OrderEvent[] = [];
    await mgr.subscribe((e) => replayed.push(e));

    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.order.context).toEqual(ctx);
    // El cache quedó actualizado: futuros subscribers no re-leen Redis para
    // este id.
    expect(mgr.getSnapshot()[0]?.context).toEqual(ctx);
  });

  it('forwards live updates to all subscribers', async () => {
    const { stream, mgr } = buildManager();
    const subA: OrderEvent[] = [];
    const subB: OrderEvent[] = [];
    await mgr.subscribe((e) => subA.push(e));
    await mgr.subscribe((e) => subB.push(e));

    stream.emit(makeEvent(order({ id: 'A', status: 'filled' }), 'liveUpdate'));
    await mgr.idle();

    expect(subA).toHaveLength(1);
    expect(subB).toHaveLength(1);
    expect(subA[0]?.order.id).toBe('A');
    expect(subB[0]?.order.id).toBe('A');
  });

  it('stops delivering events after unsubscribe', async () => {
    const { stream, mgr } = buildManager();
    const events: OrderEvent[] = [];
    const sub = await mgr.subscribe((e) => events.push(e));
    stream.emit(makeEvent(order({ id: 'A' }), 'liveUpdate'));
    await mgr.idle();
    sub.unsubscribe();
    stream.emit(makeEvent(order({ id: 'B' }), 'liveUpdate'));
    await mgr.idle();

    expect(events.map((e) => e.order.id)).toEqual(['A']);
  });

  it('reconciles re-snapshot on reconnect without duplicating to consumers', async () => {
    const { stream, mgr } = buildManager();
    stream.emit(makeEvent(order({ id: 'A', status: 'open' }), 'priorState'));
    await mgr.idle();

    const received: OrderEvent[] = [];
    await mgr.subscribe((e) => received.push(e));
    // Replay del subscribe = 1 evento.
    expect(received).toHaveLength(1);
    expect(received[0]?.order.status).toBe('open');

    // Simula reconexión: TS reenvía snapshot, A ahora llega como filled.
    stream.emitConnection(true);
    stream.emit(makeEvent(order({ id: 'A', status: 'filled' }), 'priorState'));
    await mgr.idle();

    // El subscriber recibe UN evento más (el re-snapshot), no dos.
    expect(received).toHaveLength(2);
    expect(received[1]?.order.status).toBe('filled');
    // El snapshot del manager refleja el último estado.
    expect(mgr.getSnapshot()[0]?.status).toBe('filled');
  });

  it('exposes connection state and forwards changes to subscribers', () => {
    const { stream, mgr } = buildManager();
    const states: boolean[] = [];
    mgr.onConnectionChange((c) => states.push(c));

    stream.emitConnection(true);
    stream.emitConnection(false);
    stream.emitConnection(true);

    expect(states).toEqual([true, false, true]);
    expect(mgr.isConnected()).toBe(true);
  });

  it('start() wires connect() on the underlying stream', async () => {
    const { stream, mgr } = buildManager();
    await mgr.start();
    expect(stream.connected).toBe(1);
    expect(mgr.isConnected()).toBe(true);
  });

  it('persiste entryFillPrice cuando llega un fill de la pierna entry', async () => {
    const { stream, repo, mgr } = buildManager();
    const ctx = makeContext({
      bracket: {
        entryOrderId: 'E1',
        stopOrderId: 'S1',
        takeProfitOrderId: 'T1',
      },
    });
    await repo.put(ctx);

    stream.emit(
      makeEvent(
        order({
          id: 'E1',
          status: 'filled',
          filledPrice: 187.42,
          filledQuantity: 100,
        }),
        'liveUpdate',
      ),
    );
    await mgr.idle();

    const updated = await repo.getByOrderId('E1');
    expect(updated?.entryFillPrice).toBe(187.42);
    expect(updated?.entryFillQuantity).toBe(100);
    expect(updated?.exitFillPrice).toBeUndefined();
  });

  it('persiste exitFillPrice y exitLeg cuando llega un fill de la pierna stop', async () => {
    const { stream, repo, mgr } = buildManager();
    const ctx = makeContext({
      bracket: {
        entryOrderId: 'E1',
        stopOrderId: 'S1',
        takeProfitOrderId: 'T1',
      },
    });
    await repo.put(ctx);

    stream.emit(
      makeEvent(
        order({
          id: 'S1',
          status: 'filled',
          filledPrice: 185.0,
          filledQuantity: 100,
        }),
        'liveUpdate',
      ),
    );
    await mgr.idle();

    const updated = await repo.getByOrderId('E1');
    expect(updated?.exitFillPrice).toBe(185.0);
    expect(updated?.exitFillQuantity).toBe(100);
    expect(updated?.exitLeg).toBe('stop');
  });
});
