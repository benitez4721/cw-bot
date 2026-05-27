export type IndicatorInterval =
  | '1min'
  | '5min'
  | '15min'
  | '30min'
  | '60min'
  | 'daily'
  | 'weekly'
  | 'monthly';

export type IntradayInterval = '1min' | '5min' | '15min' | '30min' | '60min';

export type SeriesType = 'open' | 'high' | 'low' | 'close';

export interface VWAP {
  value: number;
  timestamp: string;
}

export interface MACD {
  macd: number;
  signal: number;
  histogram: number;
  timestamp: string;
}

export interface ATR {
  value: number;
  timestamp: string;
}

export type SwingLabel = 'HH' | 'HL' | 'LH' | 'LL';

export interface SwingPoint {
  label: SwingLabel;
  price: number;
  barIndex: number;
  timestamp: string;
  emaValue?: number;
  emaBounceConfirmed?: boolean;
}

export interface MarketStructure {
  swings: SwingPoint[];
  bullish: boolean;
  barCount: number;
  timestamp: string;
}
