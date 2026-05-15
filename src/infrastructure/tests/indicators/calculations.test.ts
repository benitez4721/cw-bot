import { describe, it, expect } from 'vitest';
import type { Bar } from '../../../domain/marketdata/MarketDataTypes.js';
import {
  aggregateOneFiveMinuteBucket,
  calcEMA,
  calcMACD,
  calcSessionVWAP,
  toEasternDate,
} from '../../indicators/calculations.js';

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
