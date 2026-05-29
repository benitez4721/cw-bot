import type { DecisionModel } from './DecisionModel.js';

interface EventStrategyBase {
  readonly name: string;
  readonly cwConfigId: string;
  readonly quantity: number;
  readonly entryBufferBps: number;
  readonly accountId: string;
  // Gate opcional. Cuando está definido, AlertEventManager invoca
  // model.buildSnapshot + model.evaluate antes de operar y descarta el
  // alert si action === 'hold'. Solo `action` se consume del signal —
  // entryLimitPrice/quantity/stopOffset siguen viniendo de esta config.
  readonly model?: DecisionModel;
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
