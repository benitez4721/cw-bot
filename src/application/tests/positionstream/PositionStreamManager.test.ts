import { describe, expect, it } from 'vitest';
import type { Position } from '../../../domain/broker/BrokerTypes.js';
import type {
  PositionEvent,
  PositionStreamHandler,
  StreamConnectionHandler,
} from '../../../domain/broker/BrokerStreamTypes.js';
import type { PositionStreamPort } from '../../../domain/broker/PositionStreamPort.js';
import { PositionStreamManager } from '../../positionstream/PositionStreamManager.js';

class FakePositionStream implements PositionStreamPort {
  private positionHandlers: PositionStreamHandler[] = [];
  private connectionHandlers: StreamConnectionHandler[] = [];
  connected = 0;

  async connect(): Promise<void> {
    this.connected++;
    for (const h of this.connectionHandlers) h(true);
  }
  disconnect(): void {
    for (const h of this.connectionHandlers) h(false);
  }
  onPosition(h: PositionStreamHandler): void {
    this.positionHandlers.push(h);
  }
  onConnectionChange(h: StreamConnectionHandler): void {
    this.connectionHandlers.push(h);
  }
  emit(event: PositionEvent): void {
    for (const h of this.positionHandlers) h(event);
  }
}

function pos(overrides: Partial<Position> = {}): Position {
  return {
    symbol: 'AAPL',
    quantity: 100,
    averagePrice: 187,
    marketValue: 18700,
    unrealizedPnL: 0,
    ...overrides,
  };
}

function makeEvent(
  p: Position,
  origin: 'priorState' | 'liveUpdate',
): PositionEvent {
  return {
    position: p,
    accountId: 'SIM12345',
    observedAt: '2026-05-10T18:00:00Z',
    origin,
  };
}

describe('PositionStreamManager', () => {
  it('replays the current snapshot synchronously when subscribing', () => {
    const stream = new FakePositionStream();
    const mgr = new PositionStreamManager({ stream, accountId: 'SIM12345' });
    stream.emit(makeEvent(pos({ symbol: 'AAPL' }), 'priorState'));
    stream.emit(makeEvent(pos({ symbol: 'NVDA' }), 'priorState'));

    const received: PositionEvent[] = [];
    mgr.subscribe((e) => received.push(e));

    expect(received.map((e) => e.position.symbol)).toEqual(['AAPL', 'NVDA']);
    expect(received.every((e) => e.origin === 'priorState')).toBe(true);
  });

  it('removes positions from the snapshot when quantity reaches 0', () => {
    const stream = new FakePositionStream();
    const mgr = new PositionStreamManager({ stream, accountId: 'SIM12345' });
    stream.emit(
      makeEvent(pos({ symbol: 'AAPL', quantity: 100 }), 'liveUpdate'),
    );
    expect(mgr.getSnapshot()).toHaveLength(1);

    stream.emit(makeEvent(pos({ symbol: 'AAPL', quantity: 0 }), 'liveUpdate'));
    expect(mgr.getSnapshot()).toHaveLength(0);
  });

  it('still forwards quantity=0 events to live subscribers', () => {
    const stream = new FakePositionStream();
    const mgr = new PositionStreamManager({ stream, accountId: 'SIM12345' });
    stream.emit(
      makeEvent(pos({ symbol: 'AAPL', quantity: 100 }), 'liveUpdate'),
    );

    const received: PositionEvent[] = [];
    mgr.subscribe((e) => received.push(e));
    // Replay = 1 evento.
    expect(received).toHaveLength(1);

    stream.emit(makeEvent(pos({ symbol: 'AAPL', quantity: 0 }), 'liveUpdate'));
    // El cierre se propaga aunque saquemos la posición del map.
    expect(received).toHaveLength(2);
    expect(received[1]?.position.quantity).toBe(0);
  });

  it('does not replay closed positions to new subscribers', () => {
    const stream = new FakePositionStream();
    const mgr = new PositionStreamManager({ stream, accountId: 'SIM12345' });
    stream.emit(
      makeEvent(pos({ symbol: 'AAPL', quantity: 100 }), 'liveUpdate'),
    );
    stream.emit(makeEvent(pos({ symbol: 'AAPL', quantity: 0 }), 'liveUpdate'));

    const received: PositionEvent[] = [];
    mgr.subscribe((e) => received.push(e));
    expect(received).toHaveLength(0);
  });

  it('reconciles updates by overwriting the snapshot entry', () => {
    const stream = new FakePositionStream();
    const mgr = new PositionStreamManager({ stream, accountId: 'SIM12345' });
    stream.emit(
      makeEvent(pos({ symbol: 'AAPL', unrealizedPnL: 0 }), 'priorState'),
    );
    stream.emit(
      makeEvent(pos({ symbol: 'AAPL', unrealizedPnL: 250 }), 'liveUpdate'),
    );

    expect(mgr.getSnapshot()).toHaveLength(1);
    expect(mgr.getSnapshot()[0]?.unrealizedPnL).toBe(250);
  });

  it('stops delivering events after unsubscribe', () => {
    const stream = new FakePositionStream();
    const mgr = new PositionStreamManager({ stream, accountId: 'SIM12345' });
    const received: PositionEvent[] = [];
    const sub = mgr.subscribe((e) => received.push(e));
    stream.emit(makeEvent(pos({ symbol: 'AAPL' }), 'liveUpdate'));
    sub.unsubscribe();
    stream.emit(makeEvent(pos({ symbol: 'NVDA' }), 'liveUpdate'));

    expect(received.map((e) => e.position.symbol)).toEqual(['AAPL']);
  });

  it('start() connects the underlying stream', async () => {
    const stream = new FakePositionStream();
    const mgr = new PositionStreamManager({ stream, accountId: 'SIM12345' });
    await mgr.start();
    expect(stream.connected).toBe(1);
    expect(mgr.isConnected()).toBe(true);
  });
});
