import type {
  MarketStructure,
  SwingLabel,
  SwingPoint,
} from './IndicatorTypes.js';
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

// True Range per bar (Wilder 1978).
//   TR_0 = high_0 - low_0  (no previous close)
//   TR_i = max(high_i - low_i,
//              |high_i - close_{i-1}|,
//              |low_i  - close_{i-1}|)
// Branches 2 and 3 capture overnight/intrabar gaps that high-low alone misses.
export function calcTrueRange(bars: Bar[]): number[] {
  const result: number[] = new Array(bars.length);
  if (bars.length === 0) return result;
  result[0] = bars[0].high - bars[0].low;
  for (let i = 1; i < bars.length; i++) {
    const prevClose = bars[i - 1].close;
    const hl = bars[i].high - bars[i].low;
    const hc = Math.abs(bars[i].high - prevClose);
    const lc = Math.abs(bars[i].low - prevClose);
    result[i] = Math.max(hl, hc, lc);
  }
  return result;
}

// ATR with Wilder smoothing (alpha = 1/period).
//   ATR_{period-1} = SMA of TR_0..TR_{period-1}  (seed)
//   ATR_i (i >= period) = (ATR_{i-1} * (period - 1) + TR_i) / period
// Returns an array aligned to `bars`. Indices 0..period-2 are NaN (no warm-up).
//
// Note: this is NOT calcEMA. calcEMA uses alpha = 2/(period+1) (modern EMA);
// Wilder's RMA uses alpha = 1/period. Mixing them yields ~half the smoothing
// and breaks comparisons against TradingView/Twelve Data.
export function calcATR(bars: Bar[], period: number): number[] {
  if (!Number.isInteger(period) || period <= 0) {
    throw new Error(
      `calcATR: period must be a positive integer, got ${period}`,
    );
  }
  const result: number[] = new Array(bars.length).fill(NaN);
  if (bars.length < period) return result;

  const tr = calcTrueRange(bars);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += tr[i];
  result[period - 1] = sum / period;

  for (let i = period; i < bars.length; i++) {
    result[i] = (result[i - 1] * (period - 1) + tr[i]) / period;
  }
  return result;
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

// ---------------------------------------------------------------------------
// Swing pivot detection & market structure
// ---------------------------------------------------------------------------

interface RawPivot {
  kind: 'high' | 'low';
  price: number;
  barIndex: number;
  timestamp: string;
}

function isSwingHigh(bars: Bar[], i: number, n: number): boolean {
  for (let j = 1; j <= n; j++) {
    if (bars[i].high <= bars[i - j].high) return false;
    if (bars[i].high <= bars[i + j].high) return false;
  }
  return true;
}

function isSwingLow(bars: Bar[], i: number, n: number): boolean {
  for (let j = 1; j <= n; j++) {
    if (bars[i].low >= bars[i - j].low) return false;
    if (bars[i].low >= bars[i + j].low) return false;
  }
  return true;
}

export function detectSwingPivots(bars: Bar[], n: number): RawPivot[] {
  const candidates: RawPivot[] = [];
  for (let i = n; i < bars.length - n; i++) {
    if (isSwingHigh(bars, i, n)) {
      candidates.push({
        kind: 'high',
        price: bars[i].high,
        barIndex: i,
        timestamp: bars[i].timestamp,
      });
    }
    if (isSwingLow(bars, i, n)) {
      candidates.push({
        kind: 'low',
        price: bars[i].low,
        barIndex: i,
        timestamp: bars[i].timestamp,
      });
    }
  }

  if (candidates.length === 0) return [];

  const alternated: RawPivot[] = [candidates[0]];
  for (let i = 1; i < candidates.length; i++) {
    const last = alternated[alternated.length - 1];
    const curr = candidates[i];
    if (curr.kind === last.kind) {
      if (curr.kind === 'high' && curr.price > last.price) {
        alternated[alternated.length - 1] = curr;
      } else if (curr.kind === 'low' && curr.price < last.price) {
        alternated[alternated.length - 1] = curr;
      }
    } else {
      alternated.push(curr);
    }
  }

  return alternated;
}

export function classifyMarketStructure(
  bars: Bar[],
  n: number,
): MarketStructure {
  const empty: MarketStructure = {
    swings: [],
    bullish: false,
    timestamp: bars.length > 0 ? bars[bars.length - 1].timestamp : '',
  };
  if (bars.length < 2 * n + 1) return empty;

  const pivots = detectSwingPivots(bars, n);
  const swings: SwingPoint[] = [];
  let prevHigh: RawPivot | null = null;
  let prevLow: RawPivot | null = null;

  for (const p of pivots) {
    if (p.kind === 'high') {
      if (prevHigh !== null) {
        const label: SwingLabel = p.price > prevHigh.price ? 'HH' : 'LH';
        swings.push({
          label,
          price: p.price,
          barIndex: p.barIndex,
          timestamp: p.timestamp,
        });
      }
      prevHigh = p;
    } else {
      if (prevLow !== null) {
        const label: SwingLabel = p.price > prevLow.price ? 'HL' : 'LL';
        swings.push({
          label,
          price: p.price,
          barIndex: p.barIndex,
          timestamp: p.timestamp,
        });
      }
      prevLow = p;
    }
  }

  let lastHighSwing: SwingPoint | undefined;
  let lastLowSwing: SwingPoint | undefined;
  for (let i = swings.length - 1; i >= 0; i--) {
    const s = swings[i];
    if (!lastHighSwing && (s.label === 'HH' || s.label === 'LH'))
      lastHighSwing = s;
    if (!lastLowSwing && (s.label === 'HL' || s.label === 'LL'))
      lastLowSwing = s;
    if (lastHighSwing && lastLowSwing) break;
  }
  const bullish = lastHighSwing?.label === 'HH' && lastLowSwing?.label === 'HL';

  return {
    swings,
    bullish,
    timestamp: bars[bars.length - 1].timestamp,
  };
}
