import { describe, expect, it, vi } from 'vitest';
import { TradeStationStreamConnection } from '../../../broker/tradestation/TradeStationStreamConnection.js';
import type { TradeStationClient } from '../../../broker/tradestation/TradeStationClient.js';

type ScheduleEntry = {
  id: number;
  fn: () => void;
  delay: number;
};

function makeFakeTimers() {
  const pending = new Map<number, ScheduleEntry>();
  let nextId = 1;
  const schedule = (fn: () => void, delay: number) => {
    const id = nextId++;
    pending.set(id, { id, fn, delay });
    return id as unknown as NodeJS.Timeout;
  };
  const cancel = (h: NodeJS.Timeout) => {
    pending.delete(h as unknown as number);
  };
  const flush = (id: number) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    entry.fn();
  };
  const flushOldest = () => {
    const first = pending.values().next().value as ScheduleEntry | undefined;
    if (!first) return;
    pending.delete(first.id);
    first.fn();
  };
  return {
    schedule,
    cancel,
    flush,
    flushOldest,
    pending: () => Array.from(pending.values()),
  };
}

interface ManualStream {
  stream: ReadableStream<Uint8Array>;
  push: (s: string) => void;
  pushBytes: (b: Uint8Array) => void;
  end: () => void;
  error: (err: unknown) => void;
}

function manualStream(): ManualStream {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      closed = true;
    },
  });
  const encoder = new TextEncoder();
  return {
    stream,
    push: (s) => {
      if (!closed) controller.enqueue(encoder.encode(s));
    },
    pushBytes: (b) => {
      if (!closed) controller.enqueue(b);
    },
    end: () => {
      if (!closed) {
        closed = true;
        controller.close();
      }
    },
    error: (err) => {
      if (!closed) {
        closed = true;
        controller.error(err);
      }
    },
  };
}

// fetch fake that ties the AbortSignal to the stream so abort() actually
// terminates the consumer loop (the real Response body does this internally).
function fetchReturning(ms: ManualStream, status = 200): typeof fetch {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    init?.signal?.addEventListener('abort', () =>
      ms.error(new Error('aborted')),
    );
    return new Response(ms.stream, { status });
  }) as unknown as typeof fetch;
}

function fakeClient(): TradeStationClient {
  return {
    accountId: () => 'SIM12345',
    apiBase: () => 'https://sim.api.tradestation.com',
    getAccessToken: vi.fn().mockResolvedValue('tok-1'),
    invalidateToken: vi.fn(),
    tokenStatus: () => ({ cached: true, expiresInMs: 60_000 }),
    request: vi.fn(),
  } as unknown as TradeStationClient;
}

async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('TradeStationStreamConnection', () => {
  it('parses a single JSON frame in one chunk', async () => {
    const ms = manualStream();
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response(ms.stream, { status: 200 }));
    const timers = makeFakeTimers();
    const onFrame = vi.fn();
    const conn = new TradeStationStreamConnection({
      client: fakeClient(),
      pathBuilder: () => '/v3/brokerage/stream/accounts/SIM/orders',
      onFrame,
      logName: 'test',
      fetchFn,
      schedule: timers.schedule,
      cancel: timers.cancel,
    });
    conn.start();
    await flushMicrotasks();

    ms.push('{"OrderID":"1","Status":"OPN"}\n');
    await flushMicrotasks();

    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenCalledWith({ OrderID: '1', Status: 'OPN' });
    conn.stop();
  });

  it('parses frames delimited by CRLF (TradeStation real format)', async () => {
    const ms = manualStream();
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response(ms.stream, { status: 200 }));
    const timers = makeFakeTimers();
    const onFrame = vi.fn();
    const conn = new TradeStationStreamConnection({
      client: fakeClient(),
      pathBuilder: () => '/p',
      onFrame,
      logName: 'test',
      fetchFn,
      schedule: timers.schedule,
      cancel: timers.cancel,
    });
    conn.start();
    await flushMicrotasks();

    ms.push(
      '{"OrderID":"1"}\r\n{"Heartbeat":1,"Timestamp":"2026-05-10T18:00:23Z"}\r\n',
    );
    await flushMicrotasks();

    expect(onFrame).toHaveBeenCalledTimes(2);
    expect(onFrame.mock.calls.map((c) => c[0])).toEqual([
      { OrderID: '1' },
      { Heartbeat: 1, Timestamp: '2026-05-10T18:00:23Z' },
    ]);
    conn.stop();
  });

  it('parses multiple frames concatenated in one chunk', async () => {
    const ms = manualStream();
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response(ms.stream, { status: 200 }));
    const timers = makeFakeTimers();
    const onFrame = vi.fn();
    const conn = new TradeStationStreamConnection({
      client: fakeClient(),
      pathBuilder: () => '/p',
      onFrame,
      logName: 'test',
      fetchFn,
      schedule: timers.schedule,
      cancel: timers.cancel,
    });
    conn.start();
    await flushMicrotasks();

    ms.push('{"OrderID":"1"}\n{"OrderID":"2"}\n{"OrderID":"3"}\n');
    await flushMicrotasks();

    expect(onFrame).toHaveBeenCalledTimes(3);
    expect(onFrame.mock.calls.map((c) => c[0])).toEqual([
      { OrderID: '1' },
      { OrderID: '2' },
      { OrderID: '3' },
    ]);
    conn.stop();
  });

  it('buffers a frame split across two chunks until newline arrives', async () => {
    const ms = manualStream();
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response(ms.stream, { status: 200 }));
    const timers = makeFakeTimers();
    const onFrame = vi.fn();
    const conn = new TradeStationStreamConnection({
      client: fakeClient(),
      pathBuilder: () => '/p',
      onFrame,
      logName: 'test',
      fetchFn,
      schedule: timers.schedule,
      cancel: timers.cancel,
    });
    conn.start();
    await flushMicrotasks();

    ms.push('{"OrderID":"1","Status":"O');
    await flushMicrotasks();
    expect(onFrame).not.toHaveBeenCalled();

    ms.push('PN"}\n');
    await flushMicrotasks();

    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenCalledWith({ OrderID: '1', Status: 'OPN' });
    conn.stop();
  });

  it('decodes UTF-8 multi-byte characters split across chunks', async () => {
    const ms = manualStream();
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response(ms.stream, { status: 200 }));
    const timers = makeFakeTimers();
    const onFrame = vi.fn();
    const conn = new TradeStationStreamConnection({
      client: fakeClient(),
      pathBuilder: () => '/p',
      onFrame,
      logName: 'test',
      fetchFn,
      schedule: timers.schedule,
      cancel: timers.cancel,
    });
    conn.start();
    await flushMicrotasks();

    // El símbolo "€" en UTF-8 es 0xE2 0x82 0xAC. Lo partimos en dos chunks.
    const full = new TextEncoder().encode('{"Symbol":"€"}\n');
    ms.pushBytes(full.slice(0, 12));
    await flushMicrotasks();
    ms.pushBytes(full.slice(12));
    await flushMicrotasks();

    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenCalledWith({ Symbol: '€' });
    conn.stop();
  });

  it('skips invalid JSON and keeps processing subsequent frames', async () => {
    const ms = manualStream();
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response(ms.stream, { status: 200 }));
    const timers = makeFakeTimers();
    const onFrame = vi.fn();
    const conn = new TradeStationStreamConnection({
      client: fakeClient(),
      pathBuilder: () => '/p',
      onFrame,
      logName: 'test',
      fetchFn,
      schedule: timers.schedule,
      cancel: timers.cancel,
    });
    conn.start();
    await flushMicrotasks();

    ms.push('not-json\n{"OrderID":"2"}\n');
    await flushMicrotasks();

    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenCalledWith({ OrderID: '2' });
    conn.stop();
  });

  it('on 401 invalidates token and retries the connection once', async () => {
    const ms = manualStream();
    const client = fakeClient();
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response(ms.stream, { status: 200 }));
    const timers = makeFakeTimers();
    const onFrame = vi.fn();
    const conn = new TradeStationStreamConnection({
      client,
      pathBuilder: () => '/p',
      onFrame,
      logName: 'test',
      fetchFn,
      schedule: timers.schedule,
      cancel: timers.cancel,
    });
    conn.start();
    await flushMicrotasks();

    expect(client.invalidateToken).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    ms.push('{"OrderID":"after-retry"}\n');
    await flushMicrotasks();
    expect(onFrame).toHaveBeenCalledWith({ OrderID: 'after-retry' });
    conn.stop();
  });

  it('schedules reconnect with exponential backoff on connect failure', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('econnrefused'));
    const timers = makeFakeTimers();
    const conn = new TradeStationStreamConnection({
      client: fakeClient(),
      pathBuilder: () => '/p',
      onFrame: () => {},
      logName: 'test',
      fetchFn,
      schedule: timers.schedule,
      cancel: timers.cancel,
    });
    conn.start();
    await flushMicrotasks();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(timers.pending()).toHaveLength(1);
    expect(timers.pending()[0]?.delay).toBe(1000);

    timers.flushOldest();
    await flushMicrotasks();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(timers.pending()[0]?.delay).toBe(2000);

    timers.flushOldest();
    await flushMicrotasks();
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(timers.pending()[0]?.delay).toBe(4000);

    conn.stop();
  });

  it('aborts the stream when the stall timer fires', async () => {
    const ms = manualStream();
    const fetchFn = fetchReturning(ms);
    const timers = makeFakeTimers();
    const connectionChanges: boolean[] = [];
    const conn = new TradeStationStreamConnection({
      client: fakeClient(),
      pathBuilder: () => '/p',
      onFrame: () => {},
      onConnectionChange: (c) => connectionChanges.push(c),
      logName: 'test',
      fetchFn,
      schedule: timers.schedule,
      cancel: timers.cancel,
    });
    conn.start();
    await flushMicrotasks();

    expect(connectionChanges).toEqual([true]);
    // El primer timer pendiente es el stall (35s).
    const stall = timers.pending().find((p) => p.delay === 35_000);
    expect(stall).toBeDefined();
    timers.flush(stall!.id);
    await flushMicrotasks();

    // Tras el abort, el consume cierra y debería haber un onConnectionChange(false)
    // y un reconnect schedulearado.
    expect(connectionChanges).toContain(false);
    expect(timers.pending().some((p) => p.delay === 1000)).toBe(true);
    conn.stop();
  });

  it('emits onConnectionChange(true) only after the response opens', async () => {
    const ms = manualStream();
    const fetchFn = vi
      .fn()
      .mockResolvedValue(new Response(ms.stream, { status: 200 }));
    const timers = makeFakeTimers();
    const changes: boolean[] = [];
    const conn = new TradeStationStreamConnection({
      client: fakeClient(),
      pathBuilder: () => '/p',
      onFrame: () => {},
      onConnectionChange: (c) => changes.push(c),
      logName: 'test',
      fetchFn,
      schedule: timers.schedule,
      cancel: timers.cancel,
    });
    conn.start();
    await flushMicrotasks();
    expect(changes).toEqual([true]);

    conn.stop();
    await flushMicrotasks();
    expect(changes).toEqual([true, false]);
  });

  it('stop() prevents further reconnects', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('boom'));
    const timers = makeFakeTimers();
    const conn = new TradeStationStreamConnection({
      client: fakeClient(),
      pathBuilder: () => '/p',
      onFrame: () => {},
      logName: 'test',
      fetchFn,
      schedule: timers.schedule,
      cancel: timers.cancel,
    });
    conn.start();
    await flushMicrotasks();
    expect(timers.pending()).toHaveLength(1);

    conn.stop();
    expect(timers.pending()).toHaveLength(0);

    // Si el timer corriera de todos modos, no debería abrirse otra conexión.
    await flushMicrotasks();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
