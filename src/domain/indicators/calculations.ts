import type { Bar } from '../marketdata/MarketDataTypes.js';

export interface MACDPoint {
  macd: number;
  signal: number;
  histogram: number;
}

// Classic EMA (TradingView/Twelve Data convention):
//   alpha = 2 / (period + 1)
//   seed  = SMA of the first `period` values
//   ema_t = alpha * value_t + (1 - alpha) * ema_{t-1}
// Returns an array aligned to `values`. Indices 0..period-2 are NaN (no warm-up).
export function calcEMA(values: number[], period: number): number[] {
  const result: number[] = new Array(values.length).fill(NaN);
  if (period <= 0 || !Number.isFinite(period)) {
    throw new Error(
      `calcEMA: period must be a positive integer, got ${period}`,
    );
  }
  if (values.length < period) return result;

  const alpha = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  result[period - 1] = sum / period;

  for (let i = period; i < values.length; i++) {
    result[i] = alpha * values[i] + (1 - alpha) * result[i - 1];
  }
  return result;
}

export function calcMACD(
  closes: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): MACDPoint[] {
  if (fast >= slow) {
    throw new Error(
      `calcMACD: fast (${fast}) must be less than slow (${slow})`,
    );
  }

  const fastEMA = calcEMA(closes, fast);
  const slowEMA = calcEMA(closes, slow);

  const macdLine: number[] = closes.map((_, i) => {
    const f = fastEMA[i];
    const s = slowEMA[i];
    if (Number.isNaN(f) || Number.isNaN(s)) return NaN;
    return f - s;
  });

  // Signal line = EMA of MACD line, computed only over the warm region.
  const startIdx = macdLine.findIndex((v) => !Number.isNaN(v));
  const signalLine: number[] = new Array(closes.length).fill(NaN);
  if (startIdx >= 0) {
    const macdWarm = macdLine.slice(startIdx);
    const ema = calcEMA(macdWarm, signal);
    for (let i = 0; i < ema.length; i++) {
      signalLine[startIdx + i] = ema[i];
    }
  }

  return closes.map((_, i) => {
    const m = macdLine[i];
    const s = signalLine[i];
    const hist = Number.isNaN(m) || Number.isNaN(s) ? NaN : m - s;
    return { macd: m, signal: s, histogram: hist };
  });
}

export function aggregateOneFiveMinuteBucket(bars1m: Bar[]): Bar {
  if (bars1m.length !== 5) {
    throw new Error(
      `aggregateOneFiveMinuteBucket: expected 5 bars, got ${bars1m.length}`,
    );
  }
  let high = bars1m[0].high;
  let low = bars1m[0].low;
  let volume = 0;
  for (const b of bars1m) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    volume += b.volume;
  }
  return {
    timestamp: bars1m[0].timestamp,
    open: bars1m[0].open,
    high,
    low,
    close: bars1m[bars1m.length - 1].close,
    volume,
  };
}

// Cumulative session VWAP from the bars that fall on `sessionDate` in
// America/New_York. Returns NaN when total volume is zero.
//
// Caller is expected to pass 1-minute RTH bars (Polygon's AM channel only
// emits during market hours), so we don't filter by hour — only by date,
// to guard against bars carried over from the previous session in the cache.
export function calcSessionVWAP(bars1m: Bar[], sessionDate: string): number {
  let numerator = 0;
  let denominator = 0;
  for (const b of bars1m) {
    if (toEasternDate(b.timestamp) !== sessionDate) continue;
    const typical = (b.high + b.low + b.close) / 3;
    numerator += typical * b.volume;
    denominator += b.volume;
  }
  if (denominator === 0) return NaN;
  return numerator / denominator;
}

const easternDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function toEasternDate(iso: string): string {
  return easternDateFormatter.format(new Date(iso));
}
