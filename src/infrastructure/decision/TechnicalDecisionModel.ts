import type {
  DecisionModelPort,
  EvaluateInput,
  MarketSnapshot,
} from '../../domain/decision/DecisionPort.js';
import type {
  DecisionSignal,
  OrderPlan,
  RuleCheck,
} from '../../domain/decision/DecisionTypes.js';

export interface TechnicalDecisionModelParams {
  quantity: number;
  entryOffset: number;
  stopOffset: number;
  takeProfitOffset: number;
}

export class TechnicalDecisionModel implements DecisionModelPort {
  readonly name = 'technical';

  constructor(private readonly params: TechnicalDecisionModelParams) {}

  evaluate({ snapshot }: EvaluateInput): DecisionSignal {
    const checks = this.runChecks(snapshot);
    if (checks.some((c) => !c.passed)) {
      return { action: 'hold', checks };
    }
    return { action: 'buy', plan: this.buildPlan(snapshot), checks };
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
        passed: !!current && !!previous && current.histogram > 0 && previous.histogram < 0,
      },
      { name: 'price > VWAP (1min)', passed: s.quote.last > s.vwap1min.value },
    ];
  }

  private buildPlan(s: MarketSnapshot): OrderPlan {
    return {
      symbol: s.symbol,
      side: 'BUY',
      quantity: this.params.quantity,
      entryLimitPrice: round2(s.quote.last + this.params.entryOffset),
      stopOffset: this.params.stopOffset,
      takeProfitOffset: this.params.takeProfitOffset,
    };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
