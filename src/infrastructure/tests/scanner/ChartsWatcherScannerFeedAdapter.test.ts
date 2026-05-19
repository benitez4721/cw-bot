import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sentMessages: string[] = [];
let lastFakeWs: FakeWebSocket | null = null;

class FakeWebSocket extends EventEmitter {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = FakeWebSocket.CONNECTING;

  constructor(_url: string) {
    super();
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    lastFakeWs = this;
  }

  send(data: string): void {
    sentMessages.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', 1000, Buffer.from(''));
  }

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit('open');
  }

  simulateMessage(payload: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify(payload)));
  }

  simulateClose(code = 1006, reason = 'lost'): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.emit('close', code, Buffer.from(reason));
  }
}

vi.mock('ws', () => ({ default: FakeWebSocket }));

// Importar el adapter DESPUÉS del mock para que tome la clase fake.
const { ChartsWatcherScannerFeedAdapter } =
  await import('../../scanner/ChartsWatcherScannerFeedAdapter.js');

function buildAdapter() {
  return new ChartsWatcherScannerFeedAdapter({
    wsUrl: 'wss://fake/ws',
    userId: 'u',
    apiKey: 'k',
  });
}

beforeEach(() => {
  sentMessages.length = 0;
  lastFakeWs = null;
  vi.useFakeTimers();
});

describe('ChartsWatcherScannerFeedAdapter — subscribeAlert', () => {
  it('envía el payload {@type:"Alert", action:"subscribe", config_id} al WS abierto', async () => {
    const adapter = buildAdapter();
    const connecting = adapter.connect();
    lastFakeWs!.simulateOpen();
    await connecting;

    adapter.subscribeAlert('alert-123');

    const last = JSON.parse(sentMessages.at(-1)!);
    expect(last).toEqual({
      '@type': 'Alert',
      config_id: 'alert-123',
      action: 'subscribe',
    });
  });

  it('si el WS aún no abrió, queda pendiente y se envía al open', async () => {
    const adapter = buildAdapter();
    const connecting = adapter.connect();
    adapter.subscribeAlert('alert-pending');
    expect(sentMessages).toHaveLength(0);

    lastFakeWs!.simulateOpen();
    await connecting;

    const payloads = sentMessages.map((s) => JSON.parse(s));
    expect(payloads).toContainEqual({
      '@type': 'Alert',
      config_id: 'alert-pending',
      action: 'subscribe',
    });
  });
});

describe('ChartsWatcherScannerFeedAdapter — NewAlert dispatch', () => {
  it('dispatcha al callback con el requestedId cuando el config_id coincide', async () => {
    const adapter = buildAdapter();
    const received: Array<[string, string]> = [];
    adapter.onAlert((cfg, row) => received.push([cfg, row.symbol]));

    const connecting = adapter.connect();
    lastFakeWs!.simulateOpen();
    await connecting;

    adapter.subscribeAlert('alert-A');
    lastFakeWs!.simulateMessage({
      '@type': 'AlertConfirm',
      success: true,
      config_id: 'alert-A',
    });
    lastFakeWs!.simulateMessage({
      '@type': 'NewAlert',
      config_id: 'alert-A',
      row: {
        symbol: 'AAPL',
        columns: [{ key: 'PriceNOOPTION', value: '1.70' }],
      },
    });

    expect(received).toEqual([['alert-A', 'AAPL']]);
  });
});

describe('ChartsWatcherScannerFeedAdapter — reconexión', () => {
  it('re-envía el subscribeAlert al reconectarse', async () => {
    const adapter = buildAdapter();
    const connecting = adapter.connect();
    lastFakeWs!.simulateOpen();
    await connecting;

    adapter.subscribeAlert('alert-persist');
    sentMessages.length = 0;

    // Forzar drop de la conexión y reconexión: el adapter agenda
    // un setTimeout(5000) -> connect() de nuevo.
    lastFakeWs!.simulateClose();
    await vi.advanceTimersByTimeAsync(5_000);
    lastFakeWs!.simulateOpen();

    const payloads = sentMessages.map((s) => JSON.parse(s));
    expect(payloads).toContainEqual({
      '@type': 'Alert',
      config_id: 'alert-persist',
      action: 'subscribe',
    });
  });
});
