import type {
  ATR,
  EMA,
  IndicatorInterval,
  IntradayInterval,
  MACD,
  MarketStructure,
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

export interface ATRInput {
  symbol: string;
  interval: IntradayInterval;
  period?: number;
}

export interface MarketStructureInput {
  symbol: string;
  interval: IntradayInterval;
  lookback?: number;
  emaPeriod?: number;
}

export interface EMAInput {
  symbol: string;
  interval: IntradayInterval;
  period: number;
  seriesType?: SeriesType;
}

export interface IndicatorPort {
  getMACD(input: MACDInput): Promise<MACD>;
  getMACDSeries(input: MACDSeriesInput): Promise<MACD[]>;
  getVWAP(input: VWAPInput): Promise<VWAP>;
  getATR(input: ATRInput): Promise<ATR>;
  getMarketStructure(input: MarketStructureInput): Promise<MarketStructure>;
  getEMA(input: EMAInput): Promise<EMA>;
}
