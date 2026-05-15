import { describe, it, expect, beforeEach } from 'vitest';
import type { BarRepository } from '../../../domain/marketdata/BarRepository.js';
import type {
  Bar,
  BarInterval,
} from '../../../domain/marketdata/MarketDataTypes.js';
import { LocalIndicatorAdapter } from '../../indicators/LocalIndicatorAdapter.js';

function createBarRepoStub(): BarRepository & {
  _set: (s: string, i: BarInterval, b: Bar[]) => void;
} {
  const data = new Map<string, { '1min': Bar[]; '5min': Bar[] }>();
  const ensure = (s: string) => {
    let entry = data.get(s);
    if (!entry) {
      entry = { '1min': [], '5min': [] };
      data.set(s, entry);
    }
    return entry;
  };
  return {
    async get(symbol, interval) {
      return data.get(symbol)?.[interval] ?? [];
    },
    async set(symbol, interval, bars) {
      ensure(symbol)[interval] = bars;
    },
    async append(symbol, interval, bar) {
      ensure(symbol)[interval].push(bar);
    },
    async delete(symbol) {
      data.delete(symbol);
    },
    _set(symbol, interval, bars) {
      ensure(symbol)[interval] = bars;
    },
  };
}

function makeBars(closes: number[], startIso = '2026-05-07T13:30:00Z'): Bar[] {
  const start = new Date(startIso).getTime();
  return closes.map((c, i) => ({
    timestamp: new Date(start + i * 60_000).toISOString(),
    open: c,
    high: c + 0.5,
    low: c - 0.5,
    close: c,
    volume: 1000,
  }));
}

describe('LocalIndicatorAdapter', () => {
  let repo: ReturnType<typeof createBarRepoStub>;
  let adapter: LocalIndicatorAdapter;

  beforeEach(() => {
    repo = createBarRepoStub();
    // Fixed clock at 09:30 ET on 2026-05-07
    adapter = new LocalIndicatorAdapter({
      bars: repo,
      now: () => new Date('2026-05-07T13:30:00Z'),
    });
  });

  describe('getMACD', () => {
    it('returns MACD~0 on flat series', async () => {
      repo._set('AAPL', '1min', makeBars(new Array(50).fill(7)));
      const macd = await adapter.getMACD({ symbol: 'AAPL', interval: '1min' });
      expect(macd.macd).toBeCloseTo(0, 10);
      expect(macd.signal).toBeCloseTo(0, 10);
      expect(macd.histogram).toBeCloseTo(0, 10);
      expect(macd.timestamp).toBeDefined();
    });

    it('throws when insufficient warm-up', async () => {
      repo._set('AAPL', '1min', makeBars([1, 2, 3, 4, 5]));
      await expect(
        adapter.getMACD({ symbol: 'AAPL', interval: '1min' }),
      ).rejects.toThrow(/insufficient/);
    });
  });

  describe('getMACDSeries', () => {
    it('returns the last N points in DESC order (most recent first)', async () => {
      repo._set(
        'AAPL',
        '1min',
        makeBars(Array.from({ length: 60 }, (_, i) => 100 + i * 0.5)),
      );
      const series = await adapter.getMACDSeries({
        symbol: 'AAPL',
        interval: '1min',
        limit: 2,
      });
      expect(series).toHaveLength(2);
      // current = series[0] is most recent, previous = series[1]
      const t0 = new Date(series[0].timestamp).getTime();
      const t1 = new Date(series[1].timestamp).getTime();
      expect(t0).toBeGreaterThan(t1);
    });

    it('rejects non-positive limit', async () => {
      repo._set('AAPL', '1min', makeBars(new Array(50).fill(7)));
      await expect(
        adapter.getMACDSeries({ symbol: 'AAPL', interval: '1min', limit: 0 }),
      ).rejects.toThrow(/positive integer/);
    });
  });

  describe('getVWAP', () => {
    it('returns session VWAP for the current ET date', async () => {
      // Two 1m bars in the same ET session as the fixed clock (2026-05-07).
      const bars: Bar[] = [
        {
          timestamp: '2026-05-07T13:30:00Z',
          open: 100,
          high: 105,
          low: 99,
          close: 103,
          volume: 1000,
        },
        {
          timestamp: '2026-05-07T13:31:00Z',
          open: 103,
          high: 107,
          low: 102,
          close: 106,
          volume: 2000,
        },
      ];
      repo._set('AAPL', '1min', bars);
      const vwap = await adapter.getVWAP({ symbol: 'AAPL', interval: '1min' });
      expect(vwap.value).toBeCloseTo(104.1111, 3);
      expect(vwap.timestamp).toBe('2026-05-07T13:31:00Z');
    });

    it('throws when no bars match the current session', async () => {
      // Bar from previous session
      repo._set('AAPL', '1min', [
        {
          timestamp: '2026-05-06T19:30:00Z',
          open: 1,
          high: 1,
          low: 1,
          close: 1,
          volume: 1000,
        },
      ]);
      await expect(
        adapter.getVWAP({ symbol: 'AAPL', interval: '1min' }),
      ).rejects.toThrow(/no session bars/);
    });
  });
});
