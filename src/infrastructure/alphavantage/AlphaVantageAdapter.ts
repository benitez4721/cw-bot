import type {
  EMAInput,
  IndicatorPort,
  MACDInput,
  VWAPInput,
} from '../../domain/indicators/IndicatorPort.js';
import type { EMA, MACD, VWAP } from '../../domain/indicators/IndicatorTypes.js';

interface AlphaVantageConfig {
  apiKey: string;
  baseUrl: string;
}

interface AlphaVantageResponse {
  'Meta Data'?: Record<string, string>;
  Note?: string;
  Information?: string;
  'Error Message'?: string;
  [key: string]: unknown;
}

export class AlphaVantageAdapter implements IndicatorPort {
  constructor(private readonly config: AlphaVantageConfig) {}

  async getEMA(input: EMAInput): Promise<EMA> {
    const data = await this.request({
      function: 'EMA',
      symbol: input.symbol,
      interval: input.interval,
      time_period: String(input.period),
      series_type: input.seriesType ?? 'close',
    });
    const series = pickSeries(data, 'Technical Analysis: EMA');
    const [timestamp, latest] = pickLatest(series);
    return { value: parseNumber(latest['EMA']), timestamp };
  }

  async getMACD(input: MACDInput): Promise<MACD> {
    const params: Record<string, string> = {
      function: 'MACD',
      symbol: input.symbol,
      interval: input.interval,
      series_type: input.seriesType ?? 'close',
    };
    if (input.fastPeriod !== undefined) params.fastperiod = String(input.fastPeriod);
    if (input.slowPeriod !== undefined) params.slowperiod = String(input.slowPeriod);
    if (input.signalPeriod !== undefined) params.signalperiod = String(input.signalPeriod);

    const data = await this.request(params);
    const series = pickSeries(data, 'Technical Analysis: MACD');
    const [timestamp, latest] = pickLatest(series);
    return {
      macd: parseNumber(latest['MACD']),
      signal: parseNumber(latest['MACD_Signal']),
      histogram: parseNumber(latest['MACD_Hist']),
      timestamp,
    };
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

  private async request(params: Record<string, string>): Promise<AlphaVantageResponse> {
    const url = new URL(this.config.baseUrl);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('apikey', this.config.apiKey);
    url.searchParams.set('datatype', 'json');

    const res = await fetch(url);
    const text = await res.text();
    if (!res.ok) {
      console.error(
        `[AlphaVantage] HTTP ${res.status} ${params.function} ${params.symbol}:`,
        text,
      );
      throw new Error(`Alpha Vantage API error: HTTP ${res.status}`);
    }

    let parsed: AlphaVantageResponse;
    try {
      parsed = JSON.parse(text) as AlphaVantageResponse;
    } catch {
      throw new Error(`Alpha Vantage: invalid JSON response: ${text.slice(0, 200)}`);
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
  const timestamps = Object.keys(series);
  if (timestamps.length === 0) throw new Error('Alpha Vantage: empty series');
  timestamps.sort((a, b) => (a < b ? 1 : -1));
  const ts = timestamps[0];
  return [ts, series[ts]];
}

function parseNumber(value: string | undefined): number {
  if (value === undefined || value === '') return 0;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}
