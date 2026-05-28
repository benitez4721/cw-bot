interface EventStrategyBase {
  readonly name: string;
  readonly cwConfigId: string;
  readonly quantity: number;
  readonly entryBufferBps: number;
  readonly accountId: string;
}

interface PercentTrail {
  readonly trailMode: 'percent';
  readonly trailingStopPercent: number;
}

interface EmaTrail {
  readonly trailMode: 'ema';
  readonly emaTrailPeriod: number;
  readonly emaTrailBufferBps: number;
}

export type EventStrategy = EventStrategyBase & (PercentTrail | EmaTrail);
