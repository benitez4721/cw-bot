import type { DecisionModel } from './DecisionModel.js';

interface EventStrategyBase {
  readonly name: string;
  readonly cwConfigId: string;
  // Riesgo en USD por trade. La cantidad de contratos se calcula como
  // floor(riskUsd / stopOffset) en OnScannerAlert, dejando el riesgo en $
  // constante e independiente del precio del subyacente.
  readonly riskUsd: number;
  readonly entryBufferBps: number;
  readonly accountId: string;
  // Gate opcional. Cuando está definido, AlertEventManager invoca
  // model.buildSnapshot + model.evaluate antes de operar y descarta el
  // alert si action === 'hold'. Solo `action` se consume del signal —
  // entryLimitPrice/stopOffset siguen viniendo de esta config y la quantity
  // se calcula a partir de riskUsd.
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
