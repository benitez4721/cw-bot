import { describe, expect, it, vi } from 'vitest';
import { TradeStationPositionStreamAdapter } from './TradeStationPositionStreamAdapter.js';
import type { TradeStationClient } from './TradeStationClient.js';
import type { PositionEvent } from '../../domain/broker/BrokerStreamTypes.js';

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
const REAL_POSITION_FRAME = JSON.stringify({
  PositionID: '186198971',
  AccountID: 'SIM2776750M',
  Symbol: 'AIIO',
  LongShort: 'Long',
  AssetType: 'STOCK',
  Quantity: '2000',
  ConversionRate: '1',
  AveragePrice: '0.979',
  Bid: '0.826',
  Last: '0.83',
  Ask: '0.83',
  MarketValue: '1660',
  Timestamp: '2026-05-08T14:16:02Z',
  TotalCost: '1958',
  UnrealizedProfitLoss: '-298',
  UnrealizedProfitLossQty: '-0.15',
  UnrealizedProfitLossPercent: '-15.22',
  TodaysProfitLoss: '-60',
  MarkToMarketPrice: '0.86',
});

describe('TradeStationPositionStreamAdapter', () => {
  it('maps a real stream position frame to a domain Position', async () => {
    const ms = manualStream();
    const fetchFn = fetchReturning(ms);
    const t = fakeTimers();
    const adapter = new TradeStationPositionStreamAdapter({
      client: fakeClient(),
      fetchFn,
      schedule: t.schedule,
      cancel: t.cancel,
    });
    const events: PositionEvent[] = [];
    adapter.onPosition((e) => events.push(e));
    await adapter.connect();
    await flushMicrotasks();

    ms.push(REAL_POSITION_FRAME + '\r\n');
    await flushMicrotasks();

    expect(events).toHaveLength(1);
    expect(events[0]?.position).toEqual({
      symbol: 'AIIO',
      quantity: 2000,
      averagePrice: 0.979,
      marketValue: 1660,
      unrealizedPnL: -298,
    });
    expect(events[0]?.origin).toBe('priorState');
    adapter.disconnect();
  });

  it('marks events as priorState until EndSnapshot, then liveUpdate', async () => {
    const ms = manualStream();
    const fetchFn = fetchReturning(ms);
    const t = fakeTimers();
    const adapter = new TradeStationPositionStreamAdapter({
      client: fakeClient(),
      fetchFn,
      schedule: t.schedule,
      cancel: t.cancel,
    });
    const events: PositionEvent[] = [];
    adapter.onPosition((e) => events.push(e));
    await adapter.connect();
    await flushMicrotasks();

    ms.push(
      JSON.stringify({
        Symbol: 'AAPL',
        LongShort: 'Long',
        Quantity: '100',
        AveragePrice: '187',
        MarketValue: '18700',
        UnrealizedProfitLoss: '0',
      }) + '\r\n',
    );
    await flushMicrotasks();
    ms.push(JSON.stringify({ StreamStatus: 'EndSnapshot' }) + '\r\n');
    await flushMicrotasks();
    ms.push(
      JSON.stringify({
        Symbol: 'AAPL',
        LongShort: 'Long',
        Quantity: '100',
        AveragePrice: '187',
        MarketValue: '18800',
        UnrealizedProfitLoss: '100',
      }) + '\r\n',
    );
    await flushMicrotasks();

    expect(events.map((e) => [e.position.unrealizedPnL, e.origin])).toEqual([
      [0, 'priorState'],
      [100, 'liveUpdate'],
    ]);
    adapter.disconnect();
  });

  it('ignores Heartbeat, StreamStatus and Error frames', async () => {
    const ms = manualStream();
    const fetchFn = fetchReturning(ms);
    const t = fakeTimers();
    const adapter = new TradeStationPositionStreamAdapter({
      client: fakeClient(),
      fetchFn,
      schedule: t.schedule,
      cancel: t.cancel,
    });
    const events: PositionEvent[] = [];
    adapter.onPosition((e) => events.push(e));
    await adapter.connect();
    await flushMicrotasks();

    ms.push(
      JSON.stringify({ Heartbeat: 1, Timestamp: '2026-05-10T18:00:23Z' }) +
        '\r\n',
    );
    ms.push(JSON.stringify({ Error: 'SOME_ERR', Message: 'oops' }) + '\r\n');
    ms.push(
      JSON.stringify({
        Symbol: 'NVDA',
        Quantity: '50',
        AveragePrice: '500',
        MarketValue: '25000',
        UnrealizedProfitLoss: '0',
      }) + '\r\n',
    );
    await flushMicrotasks();

    expect(events).toHaveLength(1);
    expect(events[0]?.position.symbol).toBe('NVDA');
    adapter.disconnect();
  });
});
