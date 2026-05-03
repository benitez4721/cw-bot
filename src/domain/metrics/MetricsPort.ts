export type DecisionAction = 'buy' | 'sell' | 'hold';
export type TickOutcome = 'ok' | 'market_closed' | 'empty';
export type OrderRecordStatus =
  | 'pending'
  | 'open'
  | 'filled'
  | 'partiallyFilled'
  | 'cancelled'
  | 'rejected'
  | 'expired';
export type TsErrorType = 'auth' | 'http_4xx' | 'http_5xx' | 'network';
export type OauthRefreshResult = 'success' | 'failure';

export interface MetricsPort {
  recordDecision(symbol: string, action: DecisionAction): void;
  recordTick(outcome: TickOutcome): void;
  recordOrderResult(status: OrderRecordStatus): void;
  recordTsRequest(durationMs: number, errorType?: TsErrorType): void;
  recordOauthRefresh(result: OauthRefreshResult): void;
  setWatchlistSize(size: number): void;
  setScannerConnected(connected: boolean): void;
}
