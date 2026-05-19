import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TwelveDataClient } from '../../twelvedata/TwelveDataClient.js';
import { TwelveDataHistoricalBarsAdapter } from '../../marketdata/TwelveDataHistoricalBarsAdapter.js';

describe('TwelveDataHistoricalBarsAdapter.fetchHistoricalBars', () => {
  let adapter: TwelveDataHistoricalBarsAdapter;
  const fetchSpy = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal('fetch', fetchSpy);
    const client = new TwelveDataClient({
      apiKey: 'test-key',
      baseUrl: 'https://api.twelvedata.com',
      minIntervalMs: 0,
    });
    adapter = new TwelveDataHistoricalBarsAdapter(client);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function ok(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200 });
  }

  it('builds the correct time_series URL with timezone=UTC', async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({
        status: 'ok',
        values: [
          {
            datetime: '2026-05-07 13:30:00',
            open: '100',
            high: '101',
            low: '99',
            close: '100.5',
            volume: '1000',
          },
        ],
      }),
    );
    await adapter.fetchHistoricalBars({
      symbol: 'AAPL',
      interval: '1min',
      limit: 200,
    });
    const url = fetchSpy.mock.calls[0][0] as URL;
    expect(url.pathname).toBe('/time_series');
    expect(url.searchParams.get('symbol')).toBe('AAPL');
    expect(url.searchParams.get('interval')).toBe('1min');
    expect(url.searchParams.get('outputsize')).toBe('200');
    expect(url.searchParams.get('timezone')).toBe('UTC');
    expect(url.searchParams.get('prepost')).toBe('true');
    expect(url.searchParams.get('apikey')).toBe('test-key');
  });

  it('reverses DESC response to ASC and parses datetime as UTC', async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({
        status: 'ok',
        values: [
          {
            datetime: '2026-05-07 13:32:00',
            open: '102',
            high: '103',
            low: '101',
            close: '102.5',
            volume: '1500',
          },
          {
            datetime: '2026-05-07 13:31:00',
            open: '101',
            high: '102',
            low: '100',
            close: '101.5',
            volume: '1200',
          },
          {
            datetime: '2026-05-07 13:30:00',
            open: '100',
            high: '101',
            low: '99',
            close: '100.5',
            volume: '1000',
          },
        ],
      }),
    );
    const bars = await adapter.fetchHistoricalBars({
      symbol: 'AAPL',
      interval: '1min',
      limit: 3,
    });
    expect(bars).toHaveLength(3);
    expect(bars[0].timestamp).toBe('2026-05-07T13:30:00.000Z');
    expect(bars[1].timestamp).toBe('2026-05-07T13:31:00.000Z');
    expect(bars[2].timestamp).toBe('2026-05-07T13:32:00.000Z');
    expect(bars[0]).toEqual({
      timestamp: '2026-05-07T13:30:00.000Z',
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 1000,
    });
  });

  it('throws when values is empty', async () => {
    fetchSpy.mockResolvedValueOnce(ok({ status: 'ok', values: [] }));
    await expect(
      adapter.fetchHistoricalBars({
        symbol: 'AAPL',
        interval: '1min',
        limit: 10,
      }),
    ).rejects.toThrow(/empty time_series/);
  });

  it('rejects non-positive limit', async () => {
    await expect(
      adapter.fetchHistoricalBars({
        symbol: 'AAPL',
        interval: '1min',
        limit: 0,
      }),
    ).rejects.toThrow(/positive integer/);
  });

  it('propagates Twelve Data API errors', async () => {
    fetchSpy.mockResolvedValueOnce(
      ok({ status: 'error', code: 401, message: 'Invalid API key' }),
    );
    await expect(
      adapter.fetchHistoricalBars({
        symbol: 'AAPL',
        interval: '1min',
        limit: 10,
      }),
    ).rejects.toThrow(/Invalid API key/);
  });
});
