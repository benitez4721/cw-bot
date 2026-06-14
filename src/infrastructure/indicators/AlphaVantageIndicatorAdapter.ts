import type {
  ATRInput,
  EMAInput,
  IndicatorPort,
  MACDInput,
  MACDSeriesInput,
  MarketStructureInput,
  VWAPInput,
} from '../../domain/indicators/IndicatorPort.js';
import type {
  ATR,
  EMA,
  MACD,
  MarketStructure,
  VWAP,
} from '../../domain/indicators/IndicatorTypes.js';
import { logger } from '../logging/logger.js';
import { sleep } from '../../shared/async.js';
import { parseNumber } from '../shared/parsing.js';

const log = logger.child({ component: 'AlphaVantageIndicatorAdapter' });

interface AlphaVantageConfig {
  apiKey: string;
  baseUrl: string;
  minIntervalMs?: number;
}

interface AlphaVantageResponse {
  'Meta Data'?: Record<string, string>;
  Note?: string;
  Information?: string;
  'Error Message'?: string;
  [key: string]: unknown;
}

export class AlphaVantageIndicatorAdapter implements IndicatorPort {
  private readonly minIntervalMs: number;
  private nextSlotAt = 0;

  constructor(private readonly config: AlphaVantageConfig) {
    this.minIntervalMs = config.minIntervalMs ?? 250;
  }

  async getMACD(input: MACDInput): Promise<MACD> {
    const series = await this.fetchMACDSeries(input);
    const [timestamp, latest] = pickLatest(series);
    return toMACD(timestamp, latest);
  }

  async getMACDSeries(input: MACDSeriesInput): Promise<MACD[]> {
    if (!Number.isInteger(input.limit) || input.limit <= 0) {
      throw new Error('limit must be a positive integer');
    }
    const series = await this.fetchMACDSeries(input);
    return pickRecent(series, input.limit).map(([ts, row]) => toMACD(ts, row));
  }

  async getVWAP(input: VWAPInput): Promise<VWAP> {
    const data = await this.request({
      function: 'VWAP',
      symbol: input.symbol,
      interval: input.interval,
    });
    const series = pickSeries(data, 'Technical Analysis: VWAP');
    const [timestamp, latest] = pickLatest(series);
    return { value: parseNumber(latest['VWAP']), timestamp };
  }

  async getATR(_input: ATRInput): Promise<ATR> {
    throw new Error('AlphaVantageIndicatorAdapter: getATR not implemented');
  }

  async getMarketStructure(
    _input: MarketStructureInput,
  ): Promise<MarketStructure> {
    throw new Error(
      'AlphaVantageIndicatorAdapter: getMarketStructure not supported',
    );
  }

  async getEMA(_input: EMAInput): Promise<EMA> {
    throw new Error('AlphaVantageIndicatorAdapter: getEMA not implemented');
  }

  private async fetchMACDSeries(
    input: MACDInput,
  ): Promise<Record<string, Record<string, string>>> {
    const params: Record<string, string> = {
      function: 'MACD',
      symbol: input.symbol,
      interval: input.interval,
      series_type: input.seriesType ?? 'close',
    };
    if (input.fastPeriod !== undefined)
      params.fastperiod = String(input.fastPeriod);
    if (input.slowPeriod !== undefined)
      params.slowperiod = String(input.slowPeriod);
    if (input.signalPeriod !== undefined)
      params.signalperiod = String(input.signalPeriod);

    const data = await this.request(params);
    return pickSeries(data, 'Technical Analysis: MACD');
  }

  private async request(
    params: Record<string, string>,
  ): Promise<AlphaVantageResponse> {
    await this.waitForSlot();
    return this.doRequest(params);
  }

  // Reserves the next time slot for this request and waits for it. Each call
  // claims a slot at least minIntervalMs after the previous one, so concurrent
  // callers get spaced out to stay under Alpha Vantage's 10 req/s burst cap.
  private async waitForSlot(): Promise<void> {
    const now = Date.now();
    const mySlot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = mySlot + this.minIntervalMs;
    const wait = mySlot - now;
    if (wait > 0) await sleep(wait);
  }

  private async doRequest(
    params: Record<string, string>,
  ): Promise<AlphaVantageResponse> {
    const url = new URL(this.config.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('apikey', this.config.apiKey);
    url.searchParams.set('datatype', 'json');

    const res = await fetch(url);
    const text = await res.text();
    if (!res.ok) {
      log.error(
        {
          status: res.status,
          fn: params.function,
          symbol: params.symbol,
          body: text,
        },
        'http error',
      );
      throw new Error(`Alpha Vantage API error: HTTP ${res.status}`);
    }

    let parsed: AlphaVantageResponse;
    try {
      parsed = JSON.parse(text) as AlphaVantageResponse;
    } catch {
      throw new Error(
        `Alpha Vantage: invalid JSON response: ${text.slice(0, 200)}`,
      );
    }

    if (parsed['Error Message']) {
      throw new Error(`Alpha Vantage: ${parsed['Error Message']}`);
    }
    if (parsed.Note) {
      throw new Error(`Alpha Vantage rate limit: ${parsed.Note}`);
    }
    if (parsed.Information) {
      throw new Error(`Alpha Vantage: ${parsed.Information}`);
    }
    return parsed;
  }
}

function pickSeries(
  data: AlphaVantageResponse,
  key: string,
): Record<string, Record<string, string>> {
  const series = data[key];
  if (!series || typeof series !== 'object') {
    throw new Error(`Alpha Vantage: missing key "${key}" in response`);
  }
  return series as Record<string, Record<string, string>>;
}

function pickLatest(
  series: Record<string, Record<string, string>>,
): [string, Record<string, string>] {
  const [first] = pickRecent(series, 1);
  return first;
}

function pickRecent(
  series: Record<string, Record<string, string>>,
  limit: number,
): Array<[string, Record<string, string>]> {
  const timestamps = Object.keys(series);
  if (timestamps.length === 0) throw new Error('Alpha Vantage: empty series');
  timestamps.sort((a, b) => (a < b ? 1 : -1));
  return timestamps.slice(0, limit).map((ts) => [ts, series[ts]]);
}

function toMACD(timestamp: string, row: Record<string, string>): MACD {
  return {
    macd: parseNumber(row['MACD']),
    signal: parseNumber(row['MACD_Signal']),
    histogram: parseNumber(row['MACD_Hist']),
    timestamp,
  };
}
