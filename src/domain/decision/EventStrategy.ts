export interface EventStrategy {
  readonly name: string;
  readonly cwConfigId: string;
  readonly quantity: number;
  readonly trailingStopPercent: number;
  readonly entryBufferBps: number;
}
