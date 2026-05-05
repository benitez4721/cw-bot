import type {
  DecisionModelPort,
  EvaluateInput,
} from '../../domain/decision/DecisionPort.js';
import type {
  DecisionSignal,
  MarketSnapshot,
  OrderConfig,
  RuleCheck,
} from '../../domain/decision/DecisionTypes.js';

export interface TechnicalDecisionModelParams extends OrderConfig {
  entryOffset: number;
}

const DEFAULT_PARAMS: TechnicalDecisionModelParams = {
  quantity: 2000,
  entryOffset: 0.05,
  stopOffset: 0.2,
  takeProfitOffset: 0.35,
};

export class TechnicalDecisionModel implements DecisionModelPort {
  readonly name = 'technical';
  readonly orderConfig: OrderConfig;
  private readonly params: TechnicalDecisionModelParams;

  constructor(params: Partial<TechnicalDecisionModelParams> = {}) {
    this.params = { ...DEFAULT_PARAMS, ...params };
    this.orderConfig = {
      quantity: this.params.quantity,
      stopOffset: this.params.stopOffset,
      takeProfitOffset: this.params.takeProfitOffset,
    };
  }

  evaluate({ snapshot }: EvaluateInput): DecisionSignal {
    const checks = this.runChecks(snapshot);
    if (checks.some((c) => !c.passed)) {
      return { action: 'hold', checks };
    }
    return {
      action: 'buy',
      symbol: snapshot.symbol,
      side: 'BUY',
      entryLimitPrice: round2(snapshot.quote.last + this.params.entryOffset),
      checks,
      snapshot,
    };
  }

  private runChecks(s: MarketSnapshot): RuleCheck[] {
    const m5 = s.macd5min;
    const m1 = s.macd1minSeries;
    const current = m1[0];
    const previous = m1[1];

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
      { name: 'price > VWAP (1min)', passed: s.quote.last > s.vwap1min.value },
    ];
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
