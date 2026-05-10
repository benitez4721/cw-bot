import { describe, expect, it } from 'vitest';
import type { Order } from '../../domain/broker/BrokerTypes.js';
import type {
  OrderEvent,
  OrderStreamHandler,
  StreamConnectionHandler,
} from '../../domain/broker/BrokerStreamTypes.js';
import type { OrderStreamPort } from '../../domain/broker/OrderStreamPort.js';
import { OrderStreamManager } from './OrderStreamManager.js';

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
  return { order: o, observedAt: '2026-05-10T18:00:00Z', origin };
}

describe('OrderStreamManager', () => {
  it('replays the current snapshot synchronously when subscribing', () => {
    const stream = new FakeOrderStream();
    const mgr = new OrderStreamManager({
      stream,
      now: () => '2026-05-10T18:01:00Z',
    });
    stream.emit(makeEvent(order({ id: 'A' }), 'priorState'));
    stream.emit(makeEvent(order({ id: 'B' }), 'priorState'));

    const received: OrderEvent[] = [];
    mgr.subscribe((e) => received.push(e));

    expect(received.map((e) => e.order.id)).toEqual(['A', 'B']);
    expect(received.every((e) => e.origin === 'priorState')).toBe(true);
    expect(received[0]?.observedAt).toBe('2026-05-10T18:01:00Z');
  });

  it('forwards live updates to all subscribers', () => {
    const stream = new FakeOrderStream();
    const mgr = new OrderStreamManager({ stream });
    const subA: OrderEvent[] = [];
    const subB: OrderEvent[] = [];
    mgr.subscribe((e) => subA.push(e));
    mgr.subscribe((e) => subB.push(e));

    stream.emit(makeEvent(order({ id: 'A', status: 'filled' }), 'liveUpdate'));

    expect(subA).toHaveLength(1);
    expect(subB).toHaveLength(1);
    expect(subA[0]?.order.id).toBe('A');
    expect(subB[0]?.order.id).toBe('A');
  });

  it('stops delivering events after unsubscribe', () => {
    const stream = new FakeOrderStream();
    const mgr = new OrderStreamManager({ stream });
    const events: OrderEvent[] = [];
    const sub = mgr.subscribe((e) => events.push(e));
    stream.emit(makeEvent(order({ id: 'A' }), 'liveUpdate'));
    sub.unsubscribe();
    stream.emit(makeEvent(order({ id: 'B' }), 'liveUpdate'));

    expect(events.map((e) => e.order.id)).toEqual(['A']);
  });

  it('reconciles re-snapshot on reconnect without duplicating to consumers', () => {
    const stream = new FakeOrderStream();
    const mgr = new OrderStreamManager({ stream });
    stream.emit(makeEvent(order({ id: 'A', status: 'open' }), 'priorState'));

    const received: OrderEvent[] = [];
    mgr.subscribe((e) => received.push(e));
    // Replay del subscribe = 1 evento.
    expect(received).toHaveLength(1);
    expect(received[0]?.order.status).toBe('open');

    // Simula reconexión: TS reenvía snapshot, A ahora llega como filled.
    stream.emitConnection(true);
    stream.emit(makeEvent(order({ id: 'A', status: 'filled' }), 'priorState'));

    // El subscriber recibe UN evento más (el re-snapshot), no dos.
    expect(received).toHaveLength(2);
    expect(received[1]?.order.status).toBe('filled');
    // El snapshot del manager refleja el último estado.
    expect(mgr.getSnapshot()[0]?.status).toBe('filled');
  });

  it('exposes connection state and forwards changes to subscribers', () => {
    const stream = new FakeOrderStream();
    const mgr = new OrderStreamManager({ stream });
    const states: boolean[] = [];
    mgr.onConnectionChange((c) => states.push(c));

    stream.emitConnection(true);
    stream.emitConnection(false);
    stream.emitConnection(true);

    expect(states).toEqual([true, false, true]);
    expect(mgr.isConnected()).toBe(true);
  });

  it('start() wires connect() on the underlying stream', async () => {
    const stream = new FakeOrderStream();
    const mgr = new OrderStreamManager({ stream });
    await mgr.start();
    expect(stream.connected).toBe(1);
    expect(mgr.isConnected()).toBe(true);
  });
});
