import { describe, expect, it, vi } from 'vitest';
import { TradeStationOrderStreamAdapter } from './TradeStationOrderStreamAdapter.js';
import type { TradeStationClient } from './TradeStationClient.js';
import type { OrderEvent } from '../../domain/broker/BrokerStreamTypes.js';

interface ManualStream {
  stream: ReadableStream<Uint8Array>;
  push: (s: string) => void;
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

function fakeTimers() {
  type Entry = { id: number; fn: () => void };
  const pending = new Map<number, Entry>();
  let id = 1;
  return {
    schedule: (fn: () => void) => {
      const i = id++;
      pending.set(i, { id: i, fn });
      return i as unknown as NodeJS.Timeout;
    },
    cancel: (h: NodeJS.Timeout) => {
      pending.delete(h as unknown as number);
    },
  };
}

async function flushMicrotasks(times = 30): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

// Frame real capturado de la cuenta SIM (ver scripts/probe-ts-stream.ts).
const REAL_STOP_ORDER_FRAME = JSON.stringify({
  AccountID: 'SIM2776750M',
  AdvancedOptions: 'STPTRG=STT;OSO=950905109;BRK=3117388917;',
  ClosedDateTime: '2026-05-08T20:00:00Z',
  CommissionFee: '0',
  ConditionalOrders: [{ OrderID: '950905108', Relationship: 'BRK' }],
  Currency: 'USD',
  Duration: 'GTC',
  FilledPrice: '0',
  GoodTillDate: '2026-08-06T00:00:00Z',
  GroupName: 'Brk 3117388917',
  Legs: [
    {
      AssetType: 'STOCK',
      BuyOrSell: 'Sell',
      ExecQuantity: '0',
      OpenOrClose: 'Close',
      QuantityOrdered: '2000',
      QuantityRemaining: '0',
      Symbol: 'AIIO',
    },
  ],
  OpenedDateTime: '2026-05-08T14:16:01Z',
  OrderID: '950905107',
  OrderType: 'StopMarket',
  PriceUsedForBuyingPower: '0.78',
  Routing: 'Intelligent',
  Status: 'DON',
  StatusDescription: 'Queued',
  StopPrice: '0.78',
  UnbundledRouteFee: '0',
});

describe('TradeStationOrderStreamAdapter', () => {
  it('maps a real stream order frame to a domain Order', async () => {
    const ms = manualStream();
    const fetchFn = fetchReturning(ms);
    const t = fakeTimers();
    const adapter = new TradeStationOrderStreamAdapter({
      client: fakeClient(),
      fetchFn,
      schedule: t.schedule,
      cancel: t.cancel,
    });
    const events: OrderEvent[] = [];
    adapter.onOrder((e) => events.push(e));
    await adapter.connect();
    await flushMicrotasks();

    ms.push(REAL_STOP_ORDER_FRAME + '\r\n');
    await flushMicrotasks();

    expect(events).toHaveLength(1);
    expect(events[0]?.order).toEqual({
      id: '950905107',
      symbol: 'AIIO',
      quantity: 2000,
      side: 'SELL',
      type: 'StopMarket',
      status: 'pending',
      filledQuantity: 0,
      stopPrice: 0.78,
      limitPrice: undefined,
      createdAt: '2026-05-08T14:16:01Z',
    });
    expect(events[0]?.origin).toBe('priorState');
    // FilledPrice='0' no debe propagarse como precio real.
    expect(events[0]?.filledPrice).toBeUndefined();
    adapter.disconnect();
  });

  it('marks events as priorState until EndSnapshot, then liveUpdate', async () => {
    const ms = manualStream();
    const fetchFn = fetchReturning(ms);
    const t = fakeTimers();
    const adapter = new TradeStationOrderStreamAdapter({
      client: fakeClient(),
      fetchFn,
      schedule: t.schedule,
      cancel: t.cancel,
    });
    const events: OrderEvent[] = [];
    adapter.onOrder((e) => events.push(e));
    await adapter.connect();
    await flushMicrotasks();

    ms.push(
      JSON.stringify({
        OrderID: '1',
        Status: 'OPN',
        Legs: [{ Symbol: 'AAPL' }],
      }) + '\r\n',
    );
    await flushMicrotasks();
    ms.push(JSON.stringify({ StreamStatus: 'EndSnapshot' }) + '\r\n');
    await flushMicrotasks();
    ms.push(
      JSON.stringify({
        OrderID: '2',
        Status: 'FLL',
        Legs: [{ Symbol: 'AAPL' }],
      }) + '\r\n',
    );
    await flushMicrotasks();

    expect(events.map((e) => [e.order.id, e.origin])).toEqual([
      ['1', 'priorState'],
      ['2', 'liveUpdate'],
    ]);
    adapter.disconnect();
  });

  it('extracts filledPrice from the leg ExecutionPrice when > 0', async () => {
    const ms = manualStream();
    const fetchFn = fetchReturning(ms);
    const t = fakeTimers();
    const adapter = new TradeStationOrderStreamAdapter({
      client: fakeClient(),
      fetchFn,
      schedule: t.schedule,
      cancel: t.cancel,
    });
    const events: OrderEvent[] = [];
    adapter.onOrder((e) => events.push(e));
    await adapter.connect();
    await flushMicrotasks();

    ms.push(
      JSON.stringify({
        OrderID: '7',
        Status: 'FLL',
        FilledPrice: '0',
        Legs: [
          {
            Symbol: 'AAPL',
            BuyOrSell: 'Buy',
            QuantityOrdered: '100',
            ExecQuantity: '100',
            ExecutionPrice: '187.32',
          },
        ],
      }) + '\r\n',
    );
    await flushMicrotasks();

    expect(events).toHaveLength(1);
    expect(events[0]?.filledPrice).toBe(187.32);
    adapter.disconnect();
  });

  it('ignores Heartbeat, StreamStatus and Error frames', async () => {
    const ms = manualStream();
    const fetchFn = fetchReturning(ms);
    const t = fakeTimers();
    const adapter = new TradeStationOrderStreamAdapter({
      client: fakeClient(),
      fetchFn,
      schedule: t.schedule,
      cancel: t.cancel,
    });
    const events: OrderEvent[] = [];
    adapter.onOrder((e) => events.push(e));
    await adapter.connect();
    await flushMicrotasks();

    ms.push(
      JSON.stringify({ Heartbeat: 1, Timestamp: '2026-05-10T18:00:23Z' }) +
        '\r\n',
    );
    ms.push(JSON.stringify({ Error: 'SOME_ERR', Message: 'oops' }) + '\r\n');
    ms.push(
      JSON.stringify({
        OrderID: '99',
        Status: 'OPN',
        Legs: [{ Symbol: 'X' }],
      }) + '\r\n',
    );
    await flushMicrotasks();

    expect(events).toHaveLength(1);
    expect(events[0]?.order.id).toBe('99');
    adapter.disconnect();
  });
});
