import { describe, it, expect } from 'vitest';
import type { Bar } from '../../marketdata/MarketDataTypes.js';
import {
  aggregateOneFiveMinuteBucket,
  calcATR,
  calcEMA,
  calcMACD,
  calcSessionVWAP,
  calcTrueRange,
  classifyMarketStructure,
  detectSwingPivots,
  toEasternDate,
} from '../../indicators/calculations.js';

function bar(high: number, low: number, close: number, ts = 't'): Bar {
  return { timestamp: ts, open: close, high, low, close, volume: 0 };
}

describe('calcEMA', () => {
  it('returns all NaN when input shorter than period', () => {
    const result = calcEMA([1, 2], 3);
    expect(result).toHaveLength(2);
    expect(result.every(Number.isNaN)).toBe(true);
  });

  it('seeds with SMA at index period-1 then applies alpha recurrence', () => {
    // period=3, alpha = 2/4 = 0.5
    // SMA([10,20,30]) = 20
    // ema[3] = 0.5*40 + 0.5*20 = 30
    // ema[4] = 0.5*50 + 0.5*30 = 40
    const result = calcEMA([10, 20, 30, 40, 50], 3);
    expect(Number.isNaN(result[0])).toBe(true);
    expect(Number.isNaN(result[1])).toBe(true);
    expect(result[2]).toBeCloseTo(20, 10);
    expect(result[3]).toBeCloseTo(30, 10);
    expect(result[4]).toBeCloseTo(40, 10);
  });

  it('throws on invalid period', () => {
    expect(() => calcEMA([1, 2, 3], 0)).toThrow();
    expect(() => calcEMA([1, 2, 3], -1)).toThrow();
  });
});

describe('calcMACD', () => {
  it('returns all NaN before warm-up window', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    const macd = calcMACD(closes); // fast=12, slow=26, signal=9
    // Before slow (index < 25): macdLine NaN -> all NaN
    for (let i = 0; i < 25; i++) {
      expect(Number.isNaN(macd[i].macd)).toBe(true);
      expect(Number.isNaN(macd[i].signal)).toBe(true);
      expect(Number.isNaN(macd[i].histogram)).toBe(true);
    }
    // At index 25 macd is defined but signal needs 9 more samples
    expect(Number.isNaN(macd[25].macd)).toBe(false);
    expect(Number.isNaN(macd[25].signal)).toBe(true);
  });

  it('converges to zero on a flat series', () => {
    // 50 constant closes -> fast/slow EMAs both equal const -> MACD=0
    const closes = new Array(50).fill(7);
    const macd = calcMACD(closes);
    const last = macd[macd.length - 1];
    expect(last.macd).toBeCloseTo(0, 10);
    expect(last.signal).toBeCloseTo(0, 10);
    expect(last.histogram).toBeCloseTo(0, 10);
  });

  it('throws when fast >= slow', () => {
    expect(() => calcMACD([1, 2, 3], 12, 12, 9)).toThrow();
    expect(() => calcMACD([1, 2, 3], 26, 12, 9)).toThrow();
  });

  it('produces positive histogram on a rising series after warm-up', () => {
    // Linearly increasing closes: fast EMA tracks closer to recent (higher)
    // values than slow EMA, so MACD line is positive and grows.
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 0.5);
    const macd = calcMACD(closes);
    const last = macd[macd.length - 1];
    expect(last.macd).toBeGreaterThan(0);
    expect(last.signal).toBeGreaterThan(0);
  });
});

describe('calcTrueRange', () => {
  it('returns empty array for empty input', () => {
    expect(calcTrueRange([])).toEqual([]);
  });

  it('uses high - low for the first bar (no previous close)', () => {
    const tr = calcTrueRange([bar(10, 8, 9)]);
    expect(tr).toEqual([2]);
  });

  it('picks the max of the three branches for subsequent bars', () => {
    // bar0: high=10, low=8, close=9             -> TR0 = 2 (h-l)
    // bar1: gap up, h=12, l=11, c=11.5          -> hl=1, |h-pc|=3, |l-pc|=2 -> 3
    // bar2: gap down + wide, h=10, l=7, c=8     -> hl=3, |h-pc|=1.5, |l-pc|=4.5 -> 4.5
    const tr = calcTrueRange([bar(10, 8, 9), bar(12, 11, 11.5), bar(10, 7, 8)]);
    expect(tr[0]).toBeCloseTo(2, 10);
    expect(tr[1]).toBeCloseTo(3, 10);
    expect(tr[2]).toBeCloseTo(4.5, 10);
  });
});

describe('calcATR', () => {
  it('throws on invalid period', () => {
    expect(() => calcATR([bar(1, 0, 0.5)], 0)).toThrow();
    expect(() => calcATR([bar(1, 0, 0.5)], -1)).toThrow();
    expect(() => calcATR([bar(1, 0, 0.5)], 1.5)).toThrow();
  });

  it('returns all NaN when input shorter than period', () => {
    const result = calcATR([bar(1, 0, 0.5), bar(1, 0, 0.5)], 3);
    expect(result).toHaveLength(2);
    expect(result.every(Number.isNaN)).toBe(true);
  });

  it('seeds with SMA of TR at index period-1', () => {
    // Three bars, all with TR=2 (flat). Seed = SMA(2,2,2) = 2.
    const bars = [bar(10, 8, 9), bar(10, 8, 9), bar(10, 8, 9)];
    const atr = calcATR(bars, 3);
    expect(Number.isNaN(atr[0])).toBe(true);
    expect(Number.isNaN(atr[1])).toBe(true);
    expect(atr[2]).toBeCloseTo(2, 10);
  });

  it('applies Wilder smoothing (alpha = 1/period), NOT modern EMA alpha = 2/(period+1)', () => {
    // TRs: [2, 2, 2, 5]
    //   ATR[2] = (2+2+2)/3       = 2   (seed)
    //   ATR[3] = (2*2 + 5)/3     = 3   <- Wilder
    //   EMA[3] = 0.5*5 + 0.5*2   = 3.5 <- would fail this test
    const bars = [
      bar(10, 8, 9),
      bar(10, 8, 9),
      bar(10, 8, 9),
      bar(14, 9, 10), // prevClose=9 -> hl=5, hc=5, lc=0 -> TR=5
    ];
    const atr = calcATR(bars, 3);
    expect(atr[2]).toBeCloseTo(2, 10);
    expect(atr[3]).toBeCloseTo(3, 10);
  });

  it('converges to constant on a flat true-range series', () => {
    const bars = new Array(20).fill(0).map(() => bar(10, 8, 9));
    const atr = calcATR(bars, 14);
    // Every TR is 2, so ATR should be 2 from the seed onward.
    for (let i = 13; i < bars.length; i++) {
      expect(atr[i]).toBeCloseTo(2, 10);
    }
  });
});

describe('aggregateOneFiveMinuteBucket', () => {
  it('aggregates 5 1m bars to OHLCV correctly', () => {
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
      {
        timestamp: '2026-05-07T13:32:00Z',
        open: 106,
        high: 108,
        low: 104,
        close: 107,
        volume: 1500,
      },
      {
        timestamp: '2026-05-07T13:33:00Z',
        open: 107,
        high: 110,
        low: 106,
        close: 109,
        volume: 1800,
      },
      {
        timestamp: '2026-05-07T13:34:00Z',
        open: 109,
        high: 111,
        low: 107,
        close: 108,
        volume: 1200,
      },
    ];
    const result = aggregateOneFiveMinuteBucket(bars);
    expect(result).toEqual({
      timestamp: '2026-05-07T13:30:00Z',
      open: 100,
      high: 111,
      low: 99,
      close: 108,
      volume: 7500,
    });
  });

  it('throws if not exactly 5 bars', () => {
    const bar: Bar = {
      timestamp: 't',
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
    };
    expect(() => aggregateOneFiveMinuteBucket([])).toThrow();
    expect(() => aggregateOneFiveMinuteBucket([bar])).toThrow();
    expect(() =>
      aggregateOneFiveMinuteBucket(new Array(4).fill(bar)),
    ).toThrow();
    expect(() =>
      aggregateOneFiveMinuteBucket(new Array(6).fill(bar)),
    ).toThrow();
  });
});

describe('calcSessionVWAP', () => {
  it('returns volume-weighted typical price', () => {
    // 13:30Z -> 09:30 ET (May, EDT/UTC-4) on 2026-05-07
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
    // typical_0 = (105+99+103)/3 = 102.3333..
    // typical_1 = (107+102+106)/3 = 105
    // num = 102.3333 * 1000 + 105 * 2000 = 312333.33
    // den = 3000
    // vwap = 104.1111..
    const vwap = calcSessionVWAP(bars, '2026-05-07');
    expect(vwap).toBeCloseTo(104.1111, 3);
  });

  it('filters out bars from other sessions', () => {
    const bars: Bar[] = [
      {
        timestamp: '2026-05-06T19:30:00Z',
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume: 999,
      },
      {
        timestamp: '2026-05-07T13:30:00Z',
        open: 100,
        high: 100,
        low: 100,
        close: 100,
        volume: 1000,
      },
    ];
    const vwap = calcSessionVWAP(bars, '2026-05-07');
    expect(vwap).toBeCloseTo(100, 6);
  });

  it('returns NaN when no matching bars / zero volume', () => {
    expect(Number.isNaN(calcSessionVWAP([], '2026-05-07'))).toBe(true);
    const bars: Bar[] = [
      {
        timestamp: '2026-05-07T13:30:00Z',
        open: 1,
        high: 1,
        low: 1,
        close: 1,
        volume: 0,
      },
    ];
    expect(Number.isNaN(calcSessionVWAP(bars, '2026-05-07'))).toBe(true);
  });
});

describe('toEasternDate', () => {
  it('converts UTC ISO to NY date during EDT', () => {
    // 2026-05-07T13:30:00Z = 2026-05-07 09:30 EDT
    expect(toEasternDate('2026-05-07T13:30:00Z')).toBe('2026-05-07');
  });

  it('handles after-midnight UTC that is still previous day in NY', () => {
    // 2026-05-07T03:00:00Z = 2026-05-06 23:00 EDT
    expect(toEasternDate('2026-05-07T03:00:00Z')).toBe('2026-05-06');
  });
});

describe('detectSwingPivots', () => {
  it('detects a swing high and swing low with N=2', () => {
    const bars = [
      bar(15, 13, 14, 't0'),
      bar(14, 12, 13, 't1'),
      bar(13, 11, 12, 't2'),
      bar(12, 10, 11, 't3'),
      bar(11, 9, 10, 't4'),
      bar(12, 10, 11, 't5'),
      bar(13, 11, 12, 't6'),
      bar(14, 12, 13, 't7'),
      bar(15, 13, 14, 't8'),
      bar(14, 12, 13, 't9'),
      bar(13, 11, 12, 't10'),
    ];
    const pivots = detectSwingPivots(bars, 2);
    expect(pivots).toHaveLength(2);
    expect(pivots[0]).toMatchObject({ kind: 'low', price: 9, barIndex: 4 });
    expect(pivots[1]).toMatchObject({ kind: 'high', price: 15, barIndex: 8 });
  });

  it('enforces alternation — keeps the more extreme pivot', () => {
    const bars = [
      bar(18, 19, 18, 't0'),
      bar(20, 19, 19, 't1'),
      bar(19, 19, 19, 't2'),
      bar(22, 19, 21, 't3'),
      bar(21, 19, 20, 't4'),
    ];
    const pivots = detectSwingPivots(bars, 1);
    const highs = pivots.filter((p) => p.kind === 'high');
    expect(highs).toHaveLength(1);
    expect(highs[0].price).toBe(22);
  });

  it('returns empty for series shorter than 2N+1', () => {
    const bars = [bar(10, 8, 9, 't0'), bar(11, 9, 10, 't1')];
    expect(detectSwingPivots(bars, 2)).toEqual([]);
  });

  it('returns empty for a flat series', () => {
    const bars = Array.from({ length: 10 }, (_, i) => bar(10, 8, 9, `t${i}`));
    expect(detectSwingPivots(bars, 2)).toEqual([]);
  });
});

describe('classifyMarketStructure', () => {
  function uptrend(): Bar[] {
    const prices = [
      [10, 8],
      [9, 7],
      [8, 5],
      [9, 6],
      [10, 7],
      [13, 10],
      [15, 12],
      [14, 11],
      [12, 8],
      [11, 7],
      [10, 8],
      [12, 9],
      [14, 11],
      [16, 13],
      [18, 15],
      [17, 14],
      [15, 11],
      [14, 10],
      [13, 11],
      [15, 12],
      [17, 14],
      [19, 16],
      [21, 18],
      [20, 17],
      [18, 15],
      [17, 14],
    ];
    return prices.map(([h, l], i) => bar(h, l, (h + l) / 2, `t${i}`));
  }

  it('detects bullish structure (HH + HL)', () => {
    const result = classifyMarketStructure(uptrend(), 2);
    expect(result.bullish).toBe(true);
    const labels = result.swings.map((s) => s.label);
    expect(labels).toContain('HH');
    expect(labels).toContain('HL');
  });

  it('detects non-bullish when highs descend', () => {
    const bars = [
      bar(20, 18, 19, 't0'),
      bar(21, 19, 20, 't1'),
      bar(22, 20, 21, 't2'),
      bar(21, 19, 20, 't3'),
      bar(20, 18, 19, 't4'),
      bar(19, 17, 18, 't5'),
      bar(18, 16, 17, 't6'),
      bar(19, 17, 18, 't7'),
      bar(20, 18, 19, 't8'),
      bar(19, 17, 18, 't9'),
      bar(18, 16, 17, 't10'),
      bar(17, 15, 16, 't11'),
      bar(16, 14, 15, 't12'),
      bar(17, 15, 16, 't13'),
      bar(18, 16, 17, 't14'),
    ];
    const result = classifyMarketStructure(bars, 2);
    expect(result.bullish).toBe(false);
  });

  it('returns bullish false when not enough swings to classify', () => {
    const bars = Array.from({ length: 7 }, (_, i) =>
      bar(10 + i, 8 + i, 9 + i, `t${i}`),
    );
    const result = classifyMarketStructure(bars, 2);
    expect(result.bullish).toBe(false);
  });

  it('returns empty swings and bullish false for series < 2N+1', () => {
    const bars = [bar(10, 8, 9, 't0'), bar(11, 9, 10, 't1')];
    const result = classifyMarketStructure(bars, 2);
    expect(result.swings).toEqual([]);
    expect(result.bullish).toBe(false);
  });

  it('sets timestamp to last bar timestamp', () => {
    const result = classifyMarketStructure(uptrend(), 2);
    expect(result.timestamp).toBe(`t${uptrend().length - 1}`);
  });
});
