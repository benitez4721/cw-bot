import type {
  ATRInput,
  IndicatorPort,
  MACDInput,
  MACDSeriesInput,
  MarketStructureInput,
  VWAPInput,
} from '../../domain/indicators/IndicatorPort.js';
import type {
  ATR,
  MACD,
  MarketStructure,
  VWAP,
} from '../../domain/indicators/IndicatorTypes.js';
import type {
  TwelveDataClient,
  TwelveDataResponse,
  TwelveDataValue,
} from '../twelvedata/TwelveDataClient.js';

export class TwelveDataIndicatorAdapter implements IndicatorPort {
  constructor(private readonly client: TwelveDataClient) {}

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
    const data = await this.client.request('vwap', {
      symbol: input.symbol,
      interval: input.interval,
      outputsize: '1',
    });
    const latest = pickLatest(data);
    return { value: parseNumber(latest['vwap']), timestamp: latest.datetime };
  }

  async getATR(_input: ATRInput): Promise<ATR> {
    throw new Error('TwelveDataIndicatorAdapter: getATR not implemented');
  }

  async getMarketStructure(
    _input: MarketStructureInput,
  ): Promise<MarketStructure> {
    throw new Error(
      'TwelveDataIndicatorAdapter: getMarketStructure not supported',
    );
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
    return this.client.request('macd', params);
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

function parseNumber(value: string | undefined): number {
  if (value === undefined || value === '') return 0;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}
