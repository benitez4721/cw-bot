import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { brokerStreamRoutes } from './brokerStreamRoutes.js';
import type { OrderStreamManager } from '../../application/orderstream/OrderStreamManager.js';
import type { PositionStreamManager } from '../../application/positionstream/PositionStreamManager.js';
import type {
  OrderEvent,
  PositionEvent,
} from '../../domain/broker/BrokerStreamTypes.js';

interface Subscription {
  unsubscribe(): void;
}

class FakeOrderManager {
  private orderHandlers = new Set<(e: OrderEvent) => void>();
  private connHandlers = new Set<(c: boolean) => void>();

  subscribe(handler: (e: OrderEvent) => void): Subscription {
    this.orderHandlers.add(handler);
    return {
      unsubscribe: () => this.orderHandlers.delete(handler),
    };
  }
  onConnectionChange(handler: (c: boolean) => void): Subscription {
    this.connHandlers.add(handler);
    return {
      unsubscribe: () => this.connHandlers.delete(handler),
    };
  }
  emit(event: OrderEvent): void {
    for (const h of this.orderHandlers) h(event);
  }
  emitConnection(connected: boolean): void {
    for (const h of this.connHandlers) h(connected);
  }
  orderSubscribers(): number {
    return this.orderHandlers.size;
  }
  connSubscribers(): number {
    return this.connHandlers.size;
  }
}

class FakePositionManager {
  private posHandlers = new Set<(e: PositionEvent) => void>();
  private connHandlers = new Set<(c: boolean) => void>();

  subscribe(handler: (e: PositionEvent) => void): Subscription {
    this.posHandlers.add(handler);
    return {
      unsubscribe: () => this.posHandlers.delete(handler),
    };
  }
  onConnectionChange(handler: (c: boolean) => void): Subscription {
    this.connHandlers.add(handler);
    return {
      unsubscribe: () => this.connHandlers.delete(handler),
    };
  }
  emit(event: PositionEvent): void {
    for (const h of this.posHandlers) h(event);
  }
  positionSubscribers(): number {
    return this.posHandlers.size;
  }
  connSubscribers(): number {
    return this.connHandlers.size;
  }
}

interface ServerHandle {
  app: FastifyInstance;
  url: string;
  orderMgr: FakeOrderManager;
  positionMgr: FakePositionManager;
  close: () => Promise<void>;
}

async function startServer(): Promise<ServerHandle> {
  const orderMgr = new FakeOrderManager();
  const positionMgr = new FakePositionManager();
  const app = Fastify();
  await app.register(brokerStreamRoutes, {
    orderStream: orderMgr as unknown as OrderStreamManager,
    positionStream: positionMgr as unknown as PositionStreamManager,
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') {
    throw new Error('failed to bind test server');
  }
  return {
    app,
    url: `http://127.0.0.1:${address.port}`,
    orderMgr,
    positionMgr,
    close: async () => {
      // Cerrar conexiones SSE pendientes antes de close(). Sin esto,
      // app.close() queda esperando que las conexiones long-lived terminen
      // de su lado.
      app.server.closeAllConnections?.();
      await app.close();
    },
  };
}

// Lee del body chunks decodificándolos hasta que se cumpla `until` o se
// acumulen `maxChars` (a modo de safety).
async function readUntil(
  body: ReadableStream<Uint8Array>,
  until: (acc: string) => boolean,
  maxChars = 4096,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let acc = '';
  while (acc.length < maxChars) {
    const { value, done } = await reader.read();
    if (done) break;
    acc += decoder.decode(value, { stream: true });
    if (until(acc)) break;
  }
  return acc;
}

function makeOrderEvent(): OrderEvent {
  return {
    order: {
      id: 'O-1',
      symbol: 'AAPL',
      quantity: 100,
      side: 'BUY',
      type: 'Limit',
      status: 'open',
      createdAt: '2026-05-10T18:00:00Z',
    },
    observedAt: '2026-05-10T18:00:00Z',
    origin: 'liveUpdate',
  };
}

function makePositionEvent(): PositionEvent {
  return {
    position: {
      symbol: 'AAPL',
      quantity: 100,
      averagePrice: 187,
      marketValue: 18700,
      unrealizedPnL: 0,
    },
    observedAt: '2026-05-10T18:00:00Z',
    origin: 'liveUpdate',
  };
}

describe('brokerStreamRoutes', () => {
  let h: ServerHandle;

  beforeEach(async () => {
    h = await startServer();
  });
  afterEach(async () => {
    await h.close();
  });

  it('opens an SSE response with the right headers', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${h.url}/api/broker/stream/orders`, {
      signal: ctrl.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    ctrl.abort();
    await res.body?.cancel().catch(() => {});
  });

  it('streams an order event as a properly formatted SSE frame', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${h.url}/api/broker/stream/orders`, {
      signal: ctrl.signal,
    });
    expect(res.status).toBe(200);

    // Esperar que el subscriber esté registrado antes de emitir.
    while (h.orderMgr.orderSubscribers() === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    h.orderMgr.emit(makeOrderEvent());

    const text = await readUntil(res.body!, (a) => a.includes('\n\n'));
    expect(text).toContain('event: order');
    expect(text).toContain('id: 1');
    const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
    expect(dataLine).toBeDefined();
    const payload = JSON.parse(dataLine!.slice('data: '.length));
    expect(payload.order.id).toBe('O-1');
    expect(payload.origin).toBe('liveUpdate');

    ctrl.abort();
    await res.body?.cancel().catch(() => {});
  });

  it('streams a connection event when the manager flips state', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${h.url}/api/broker/stream/orders`, {
      signal: ctrl.signal,
    });
    while (h.orderMgr.connSubscribers() === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    h.orderMgr.emitConnection(true);

    const text = await readUntil(res.body!, (a) => a.includes('event: connection'));
    expect(text).toContain('event: connection');
    expect(text).toContain('"connected":true');

    ctrl.abort();
    await res.body?.cancel().catch(() => {});
  });

  it('cleans up subscriptions when the client disconnects', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${h.url}/api/broker/stream/orders`, {
      signal: ctrl.signal,
    });
    while (h.orderMgr.orderSubscribers() === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(h.orderMgr.orderSubscribers()).toBe(1);
    expect(h.orderMgr.connSubscribers()).toBe(1);

    ctrl.abort();
    await res.body?.cancel().catch(() => {});

    // Esperar a que el server detecte el close y limpie.
    const deadline = Date.now() + 1000;
    while (
      (h.orderMgr.orderSubscribers() !== 0 ||
        h.orderMgr.connSubscribers() !== 0) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(h.orderMgr.orderSubscribers()).toBe(0);
    expect(h.orderMgr.connSubscribers()).toBe(0);
  });

  it('streams a position event on the positions endpoint', async () => {
    const ctrl = new AbortController();
    const res = await fetch(`${h.url}/api/broker/stream/positions`, {
      signal: ctrl.signal,
    });
    while (h.positionMgr.positionSubscribers() === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    h.positionMgr.emit(makePositionEvent());

    const text = await readUntil(res.body!, (a) => a.includes('\n\n'));
    expect(text).toContain('event: position');
    const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
    const payload = JSON.parse(dataLine!.slice('data: '.length));
    expect(payload.position.symbol).toBe('AAPL');

    ctrl.abort();
    await res.body?.cancel().catch(() => {});
  });
});
