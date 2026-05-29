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
export type TsOperation =
  | 'placeBracket'
  | 'placeMarket'
  | 'placeLimit'
  | 'cancelOrder'
  | 'getOrdersByIds'
  | 'getPositions'
  | 'getOrders'
  | 'replaceStop'
  | 'getQuote';
export type OauthRefreshResult = 'success' | 'failure';
export type FlattenOutcome = 'cancelled' | 'marketSent' | 'skipped';
export type FlattenFailurePhase =
  | 'cancel'
  | 'cancelTimeout'
  | 'market'
  | 'persist';
export type AlertOutcome =
  | 'received'
  | 'opened'
  | 'skipped_busy'
  | 'skipped_closed'
  | 'skipped_model_hold'
  | 'rejected';

export interface MetricsPort {
  recordDecision(symbol: string, action: DecisionAction): void;
  recordTick(outcome: TickOutcome): void;
  recordOrderResult(status: OrderRecordStatus): void;
  recordTsRequest(
    durationMs: number,
    operation: TsOperation,
    errorType?: TsErrorType,
  ): void;
  recordOauthRefresh(result: OauthRefreshResult): void;
  setWatchlistSize(size: number): void;
  setScannerConnected(connected: boolean): void;
  // Realtime feed (Polygon AM channel) — populated by BarStreamManager.
  recordBarReceived(): void;
  recordBarDedupSkip(): void;
  recordBootstrapFailure(): void;
  setMarketFeedConnected(connected: boolean): void;
  // Pre-close flatten lifecycle (FlattenAllPositions use case).
  recordFlattenOutcome(outcome: FlattenOutcome): void;
  recordFlattenFailure(phase: FlattenFailurePhase): void;
  // Event-driven model lifecycle (HighOfDayAlert via OnScannerAlert).
  recordAlertOutcome(model: string, outcome: AlertOutcome): void;
}
