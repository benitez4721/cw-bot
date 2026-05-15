import type { BrokerPort } from '../../broker/BrokerPort.js';
import type { Quote } from '../../broker/BrokerTypes.js';
import type {
  BuildSnapshotInput,
  DecisionModel,
} from '../DecisionModel.js';
import type {
  DecisionSignal,
  RuleCheck,
} from '../DecisionTypes.js';
import type { IndicatorPort } from '../../indicators/IndicatorPort.js';
import type { MACD, VWAP } from '../../indicators/IndicatorTypes.js';

export interface MacdM1CrossOverSnapshot {
  symbol: string;
  quote: Quote;
  macd5min: MACD;
  macd1minSeries: MACD[];
  vwap1min: VWAP;
}

const PARAMS = {
  quantity: 2000,
  stopOffset: 0.2,
  takeProfitOffset: 0.35,
  entryOffsetBps: 10,
  minHistogram1minCrossoverDelta: 0.002,
} as const;

export class MacdM1CrossOverDecisionModel implements DecisionModel<MacdM1CrossOverSnapshot> {
  readonly name = 'MacdM1CrossOver';
  private readonly broker: BrokerPort;
  private readonly indicators: IndicatorPort;

  constructor(deps: { broker: BrokerPort; indicators: IndicatorPort }) {
    this.broker = deps.broker;
    this.indicators = deps.indicators;
  }

  async buildSnapshot({
    symbol,
  }: BuildSnapshotInput): Promise<MacdM1CrossOverSnapshot> {
    const [quote, macd5min, macd1minSeries, vwap1min] = await Promise.all([
      this.broker.getQuote({ symbol }),
      this.indicators.getMACD({ symbol, interval: '5min' }),
      this.indicators.getMACDSeries({ symbol, interval: '1min', limit: 2 }),
      this.indicators.getVWAP({ symbol, interval: '1min' }),
    ]);
    return { symbol, quote, macd5min, macd1minSeries, vwap1min };
  }

  evaluate(snapshot: MacdM1CrossOverSnapshot): DecisionSignal<MacdM1CrossOverSnapshot> {
    const checks = this.runChecks(snapshot);
    if (checks.some((c) => !c.passed)) {
      return { action: 'hold', checks, snapshot };
    }
    const base = snapshot.quote.ask ?? snapshot.quote.last;
    const cushion = base * (PARAMS.entryOffsetBps / 10000);
    return {
      action: 'buy',
      symbol: snapshot.symbol,
      side: 'BUY',
      entryLimitPrice: round2(base + cushion),
      quantity: PARAMS.quantity,
      stopOffset: PARAMS.stopOffset,
      takeProfitOffset: PARAMS.takeProfitOffset,
      checks,
      snapshot,
    };
  }

  private runChecks(s: MacdM1CrossOverSnapshot): RuleCheck[] {
    const m5 = s.macd5min;
    const m1 = s.macd1minSeries;
    const current = m1[0];
    const previous = m1[1];
    const minDelta = PARAMS.minHistogram1minCrossoverDelta;

    return [
      { name: '5min MACD > 0', passed: m5.macd > 0 },
      { name: '5min histogram > 0', passed: m5.histogram > 0 },
      { name: '1min MACD > 0', passed: !!current && current.macd > 0 },
      {
        name: '1min histogram bullish crossover',
        passed:
          !!current &&
          !!previous &&
          current.histogram > 0 &&
          previous.histogram < 0,
      },
      {
        name: `1min histogram crossover magnitude >= ${minDelta}`,
        passed:
          !!current &&
          !!previous &&
          current.histogram - previous.histogram >= minDelta,
      },
      { name: 'price > VWAP (1min)', passed: s.quote.last > s.vwap1min.value },
    ];
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
