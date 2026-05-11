import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { Quote } from '../../domain/broker/BrokerTypes.js';
import type {
  BuildSnapshotInput,
  DecisionModelPort,
  EvaluateInput,
} from '../../domain/decision/DecisionPort.js';
import type {
  DecisionSignal,
  OrderConfig,
  RuleCheck,
} from '../../domain/decision/DecisionTypes.js';
import type { IndicatorPort } from '../../domain/indicators/IndicatorPort.js';
import type { MACD, VWAP } from '../../domain/indicators/IndicatorTypes.js';

export interface MacdM1CrossOverSnapshot {
  symbol: string;
  quote: Quote;
  macd5min: MACD;
  macd1minSeries: MACD[];
  vwap1min: VWAP;
}

export interface MacdM1CrossOverDecisionModelAdapterParams extends OrderConfig {
  entryOffsetBps: number;
  minHistogram1minCrossoverDelta: number;
}

export interface MacdM1CrossOverDecisionModelAdapterDeps {
  broker: BrokerPort;
  indicators: IndicatorPort;
}

const DEFAULT_PARAMS: MacdM1CrossOverDecisionModelAdapterParams = {
  quantity: 2000,
  entryOffsetBps: 10,
  stopOffset: 0.2,
  takeProfitOffset: 0.35,
  minHistogram1minCrossoverDelta: 0.002,
};

export class MacdM1CrossOverDecisionModelAdapter implements DecisionModelPort<MacdM1CrossOverSnapshot> {
  readonly name = 'MacdM1CrossOver';
  readonly orderConfig: OrderConfig;
  private readonly params: MacdM1CrossOverDecisionModelAdapterParams;
  private readonly broker: BrokerPort;
  private readonly indicators: IndicatorPort;

  constructor(
    deps: MacdM1CrossOverDecisionModelAdapterDeps,
    params: Partial<MacdM1CrossOverDecisionModelAdapterParams> = {},
  ) {
    this.broker = deps.broker;
    this.indicators = deps.indicators;
    this.params = { ...DEFAULT_PARAMS, ...params };
    this.orderConfig = {
      quantity: this.params.quantity,
      stopOffset: this.params.stopOffset,
      takeProfitOffset: this.params.takeProfitOffset,
    };
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

  evaluate({
    snapshot,
  }: EvaluateInput<MacdM1CrossOverSnapshot>): DecisionSignal<MacdM1CrossOverSnapshot> {
    const checks = this.runChecks(snapshot);
    if (checks.some((c) => !c.passed)) {
      return { action: 'hold', checks, snapshot };
    }
    const base = snapshot.quote.ask ?? snapshot.quote.last;
    const cushion = base * (this.params.entryOffsetBps / 10000);
    return {
      action: 'buy',
      symbol: snapshot.symbol,
      side: 'BUY',
      entryLimitPrice: round2(base + cushion),
      checks,
      snapshot,
    };
  }

  private runChecks(s: MacdM1CrossOverSnapshot): RuleCheck[] {
    const m5 = s.macd5min;
    const m1 = s.macd1minSeries;
    const current = m1[0];
    const previous = m1[1];
    const minDelta = this.params.minHistogram1minCrossoverDelta;

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
