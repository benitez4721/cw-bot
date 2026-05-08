import type {
  IndicatorInterval,
  IntradayInterval,
  MACD,
  SeriesType,
  VWAP,
} from './IndicatorTypes.js';

export interface MACDInput {
  symbol: string;
  interval: IndicatorInterval;
  seriesType?: SeriesType;
  fastPeriod?: number;
  slowPeriod?: number;
  signalPeriod?: number;
}

export interface MACDSeriesInput extends MACDInput {
  limit: number;
}

export interface VWAPInput {
  symbol: string;
  interval: IntradayInterval;
}

export interface IndicatorPort {
  getMACD(input: MACDInput): Promise<MACD>;
  getMACDSeries(input: MACDSeriesInput): Promise<MACD[]>;
  getVWAP(input: VWAPInput): Promise<VWAP>;
}
