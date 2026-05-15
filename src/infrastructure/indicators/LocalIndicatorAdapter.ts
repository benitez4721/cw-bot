import type {
  IndicatorPort,
  MACDInput,
  MACDSeriesInput,
  VWAPInput,
} from '../../domain/indicators/IndicatorPort.js';
import type {
  IndicatorInterval,
  MACD,
  SeriesType,
  VWAP,
} from '../../domain/indicators/IndicatorTypes.js';
import type { BarRepository } from '../../domain/marketdata/BarRepository.js';
import type {
  Bar,
  BarInterval,
} from '../../domain/marketdata/MarketDataTypes.js';
import {
  calcMACD,
  calcSessionVWAP,
  toEasternDate,
} from '../../domain/indicators/calculations.js';

export interface LocalIndicatorAdapterOptions {
  bars: BarRepository;
  now?: () => Date;
}

// Implementation of IndicatorPort backed by a local BarRepository (Polygon
// realtime feed). Keeps the same shape as TwelveDataIndicatorAdapter so any
// model that depends on IndicatorPort can consume it without changes.
//
// Series are stored in the cache in chronological order (oldest first). The
// MACD series is returned descending (most recent first) to match Twelve Data.
export class LocalIndicatorAdapter implements IndicatorPort {
  private readonly bars: BarRepository;
  private readonly now: () => Date;

  constructor(options: LocalIndicatorAdapterOptions) {
    this.bars = options.bars;
    this.now = options.now ?? (() => new Date());
  }

  async getMACD(input: MACDInput): Promise<MACD> {
    const series = await this.computeMACDSeries(input);
    const last = findLastValidMACD(series);
    if (last === null) {
      throw new Error(
        `LocalIndicator: insufficient data for MACD on ${input.symbol}`,
      );
    }
    return last;
  }

  async getMACDSeries(input: MACDSeriesInput): Promise<MACD[]> {
    if (!Number.isInteger(input.limit) || input.limit <= 0) {
      throw new Error('limit must be a positive integer');
    }
    const series = await this.computeMACDSeries(input);
    const valid = series.filter(
      (p) => !Number.isNaN(p.macd) && !Number.isNaN(p.signal),
    );
    if (valid.length === 0) {
      throw new Error(
        `LocalIndicator: insufficient data for MACD series on ${input.symbol}`,
      );
    }
    return valid.slice(-input.limit).reverse();
  }

  async getVWAP(input: VWAPInput): Promise<VWAP> {
    const interval = mapToBarInterval(input.interval);
    const bars = await this.loadBars(input.symbol, interval);
    const sessionDate = toEasternDate(this.now().toISOString());
    const value = calcSessionVWAP(bars, sessionDate);
    if (Number.isNaN(value)) {
      throw new Error(
        `LocalIndicator: no session bars for VWAP on ${input.symbol} (${sessionDate})`,
      );
    }
    return { value, timestamp: bars[bars.length - 1].timestamp };
  }

  private async loadBars(
    symbol: string,
    interval: BarInterval,
  ): Promise<Bar[]> {
    const bars = await this.bars.get(symbol, interval);
    if (bars.length === 0) {
      throw new Error(
        `LocalIndicator: no cached bars for ${symbol} ${interval}`,
      );
    }
    return bars;
  }

  private async computeMACDSeries(input: MACDInput): Promise<MACD[]> {
    const interval = mapToBarInterval(input.interval);
    const seriesType: SeriesType = input.seriesType ?? 'close';
    const bars = await this.loadBars(input.symbol, interval);
    const values = bars.map((b) => readSeriesValue(b, seriesType));
    const macd = calcMACD(
      values,
      input.fastPeriod ?? 12,
      input.slowPeriod ?? 26,
      input.signalPeriod ?? 9,
    );
    return macd.map((p, i) => ({ ...p, timestamp: bars[i].timestamp }));
  }
}

function mapToBarInterval(interval: IndicatorInterval): BarInterval {
  if (interval === '1min' || interval === '5min') return interval;
  throw new Error(
    `LocalIndicator: interval ${interval} not supported (only 1min and 5min)`,
  );
}

function readSeriesValue(bar: Bar, seriesType: SeriesType): number {
  switch (seriesType) {
    case 'open':
      return bar.open;
    case 'high':
      return bar.high;
    case 'low':
      return bar.low;
    case 'close':
      return bar.close;
  }
}

function findLastValidMACD(series: MACD[]): MACD | null {
  for (let i = series.length - 1; i >= 0; i--) {
    const p = series[i];
    if (!Number.isNaN(p.macd) && !Number.isNaN(p.signal)) return p;
  }
  return null;
}
