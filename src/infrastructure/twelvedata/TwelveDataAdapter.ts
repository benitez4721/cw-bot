import type {
  IndicatorPort,
  MACDInput,
  MACDSeriesInput,
  VWAPInput,
} from '../../domain/indicators/IndicatorPort.js';
import type { MACD, VWAP } from '../../domain/indicators/IndicatorTypes.js';
import type {
  FetchHistoricalBarsInput,
  HistoricalBarsPort,
} from '../../domain/marketdata/HistoricalBarsPort.js';
import type { Bar } from '../../domain/marketdata/MarketDataTypes.js';
import { logger } from '../logging/logger.js';

const log = logger.child({ component: 'TwelveDataAdapter' });

interface TwelveDataConfig {
  apiKey: string;
  baseUrl: string;
  minIntervalMs?: number;
}

interface TwelveDataValue {
  datetime: string;
  [field: string]: string;
}

interface TwelveDataResponse {
  status?: 'ok' | 'error';
  code?: number;
  message?: string;
  meta?: Record<string, unknown>;
  values?: TwelveDataValue[];
}

export class TwelveDataAdapter implements IndicatorPort, HistoricalBarsPort {
  private readonly minIntervalMs: number;
  private nextSlotAt = 0;

  constructor(private readonly config: TwelveDataConfig) {
    this.minIntervalMs = config.minIntervalMs ?? 7500;
  }

  async getMACD(input: MACDInput): Promise<MACD> {
    const data = await this.requestMACD(input, 1);
    return toMACD(pickLatest(data));
  }

  async getMACDSeries(input: MACDSeriesInput): Promise<MACD[]> {
    if (!Number.isInteger(input.limit) || input.limit <= 0) {
      throw new Error('limit must be a positive integer');
    }
    const data = await this.requestMACD(input, input.limit);
    const values = data.values ?? [];
    if (values.length === 0) throw new Error('Twelve Data: empty series');
    return values.map(toMACD);
  }

  async getVWAP(input: VWAPInput): Promise<VWAP> {
    const data = await this.request('vwap', {
      symbol: input.symbol,
      interval: input.interval,
      outputsize: '1',
    });
    const latest = pickLatest(data);
    return { value: parseNumber(latest['vwap']), timestamp: latest.datetime };
  }

  // Bootstrap OHLCV series for the local-indicators path. Twelve Data returns
  // values DESC (most recent first); we reverse to ASC to match the cache
  // contract. timezone=UTC keeps datetimes unambiguous (default is exchange
  // local).
  async fetchHistoricalBars(input: FetchHistoricalBarsInput): Promise<Bar[]> {
    if (!Number.isInteger(input.limit) || input.limit <= 0) {
      throw new Error('limit must be a positive integer');
    }
    const data = await this.request('time_series', {
      symbol: input.symbol,
      interval: input.interval,
      outputsize: String(input.limit),
      timezone: 'UTC',
    });
    const values = data.values ?? [];
    if (values.length === 0) {
      throw new Error(`Twelve Data: empty time_series for ${input.symbol}`);
    }
    return values.map(toBar).reverse();
  }

  private async requestMACD(
    input: MACDInput,
    outputsize: number,
  ): Promise<TwelveDataResponse> {
    const params: Record<string, string> = {
      symbol: input.symbol,
      interval: input.interval,
      series_type: input.seriesType ?? 'close',
      outputsize: String(outputsize),
    };
    if (input.fastPeriod !== undefined)
      params.fast_period = String(input.fastPeriod);
    if (input.slowPeriod !== undefined)
      params.slow_period = String(input.slowPeriod);
    if (input.signalPeriod !== undefined)
      params.signal_period = String(input.signalPeriod);
    return this.request('macd', params);
  }

  private async request(
    endpoint: string,
    params: Record<string, string>,
  ): Promise<TwelveDataResponse> {
    await this.waitForSlot();
    return this.doRequest(endpoint, params);
  }

  // Reserves the next time slot for this request and waits for it. Each call
  // claims a slot at least minIntervalMs after the previous one, so concurrent
  // callers get spaced out to stay under Twelve Data's free-tier cap (8 req/min).
  private async waitForSlot(): Promise<void> {
    const now = Date.now();
    const mySlot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = mySlot + this.minIntervalMs;
    const wait = mySlot - now;
    if (wait > 0) await sleep(wait);
  }

  private async doRequest(
    endpoint: string,
    params: Record<string, string>,
  ): Promise<TwelveDataResponse> {
    const url = new URL(`${this.config.baseUrl}/${endpoint}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('apikey', this.config.apiKey);
    url.searchParams.set('format', 'JSON');

    const res = await fetch(url);
    const text = await res.text();
    if (!res.ok) {
      log.error(
        {
          status: res.status,
          endpoint,
          symbol: params.symbol,
          body: text.slice(0, 200),
        },
        'http error',
      );
      throw new Error(`Twelve Data API error: HTTP ${res.status}`);
    }

    let parsed: TwelveDataResponse;
    try {
      parsed = JSON.parse(text) as TwelveDataResponse;
    } catch {
      throw new Error(
        `Twelve Data: invalid JSON response: ${text.slice(0, 200)}`,
      );
    }

    if (parsed.status === 'error') {
      throw new Error(
        `Twelve Data: ${parsed.message ?? 'unknown error'} (code ${parsed.code ?? '?'})`,
      );
    }
    return parsed;
  }
}

function pickLatest(data: TwelveDataResponse): TwelveDataValue {
  const values = data.values ?? [];
  if (values.length === 0) throw new Error('Twelve Data: empty series');
  return values[0];
}

function toMACD(v: TwelveDataValue): MACD {
  return {
    macd: parseNumber(v['macd']),
    signal: parseNumber(v['macd_signal']),
    histogram: parseNumber(v['macd_hist']),
    timestamp: v.datetime,
  };
}

function toBar(v: TwelveDataValue): Bar {
  return {
    timestamp: parseUtcDatetime(v.datetime),
    open: parseNumber(v['open']),
    high: parseNumber(v['high']),
    low: parseNumber(v['low']),
    close: parseNumber(v['close']),
    volume: parseNumber(v['volume']),
  };
}

// Twelve Data with timezone=UTC returns 'YYYY-MM-DD HH:MM:SS' (no offset).
// Treat as UTC explicitly so downstream comparisons are unambiguous.
function parseUtcDatetime(s: string): string {
  return new Date(`${s.replace(' ', 'T')}Z`).toISOString();
}

function parseNumber(value: string | undefined): number {
  if (value === undefined || value === '') return 0;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
