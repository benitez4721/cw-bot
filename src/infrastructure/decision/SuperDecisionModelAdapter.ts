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

// ChartsWatcher scanner config that feeds this model's watchlist. Part of
// the model's definition (RVOL filter is applied upstream by CW), not a
// per-environment toggle.
export const SUPER_CW_CONFIG_ID = '69f6bec1f52a7e93e345cd0c';

export interface SuperSnapshot {
  symbol: string;
  triggerBarTimestamp?: string;
  isFiveMinClose: boolean;
  // Populated only when isFiveMinClose is true; otherwise stub values.
  quote: Quote;
  macd5minSeries: MACD[];
  vwap: VWAP;
}

export interface SuperDecisionModelAdapterParams {
  tradeBudgetUsd: number;
  stopPercent: number;
  takeProfitPercent: number;
  entryOffsetBps: number;
}

export interface SuperDecisionModelAdapterDeps {
  broker: BrokerPort;
  indicators: IndicatorPort;
}

const DEFAULT_PARAMS: SuperDecisionModelAdapterParams = {
  tradeBudgetUsd: 25_000,
  stopPercent: 0.01,
  takeProfitPercent: 0.025,
  entryOffsetBps: 10,
};

const STUB_QUOTE: Quote = { symbol: '', last: 0, timestamp: '' };
const STUB_VWAP: VWAP = { value: NaN, timestamp: '' };

// Day-trading model gated to the close of every 5-minute bucket. Buys when
// the histogram has just turned positive (3 most recent 5m bars positive,
// 4th strictly negative — confirms a neg→pos crossover whose pivot bar is
// the first of the run). Order sizing is dynamic: quantity = floor(budget
// / last); SL/TP are percentages of last fed into the bracket as offsets.
//
// Trail to break-even is configured at the strategy level
// (`DecisionStrategy.trailToBreakEvenAtProfit`), not here.
export class SuperDecisionModelAdapter implements DecisionModelPort<SuperSnapshot> {
  readonly name = 'Super';
  // Sentinels: this model always overrides quantity/offsets in the buy signal
  // (sized per-symbol). Zeros fail closed if a future bug leaves them unset.
  readonly orderConfig: OrderConfig = {
    quantity: 0,
    stopOffset: 0,
    takeProfitOffset: 0,
  };
  private readonly params: SuperDecisionModelAdapterParams;
  private readonly broker: BrokerPort;
  private readonly indicators: IndicatorPort;

  constructor(
    deps: SuperDecisionModelAdapterDeps,
    params: Partial<SuperDecisionModelAdapterParams> = {},
  ) {
    this.broker = deps.broker;
    this.indicators = deps.indicators;
    this.params = { ...DEFAULT_PARAMS, ...params };
  }

  async buildSnapshot({
    symbol,
    triggerBar,
  }: BuildSnapshotInput): Promise<SuperSnapshot> {
    const triggerBarTimestamp = triggerBar?.timestamp;
    const fiveMinClose = isFiveMinClose(triggerBarTimestamp);

    if (!fiveMinClose) {
      return {
        symbol,
        triggerBarTimestamp,
        isFiveMinClose: false,
        quote: STUB_QUOTE,
        macd5minSeries: [],
        vwap: STUB_VWAP,
      };
    }

    const [quote, macd5minSeries, vwap] = await Promise.all([
      this.broker.getQuote({ symbol }),
      this.indicators.getMACDSeries({
        symbol,
        interval: '5min',
        limit: 4,
      }),
      this.indicators.getVWAP({ symbol, interval: '5min' }),
    ]);
    return {
      symbol,
      triggerBarTimestamp,
      isFiveMinClose: true,
      quote,
      macd5minSeries,
      vwap,
    };
  }

  evaluate({
    snapshot,
  }: EvaluateInput<SuperSnapshot>): DecisionSignal<SuperSnapshot> {
    const checks = this.runChecks(snapshot);
    if (checks.some((c) => !c.passed)) {
      return { action: 'hold', checks, snapshot };
    }
    const { quote } = snapshot;
    const last = quote.last;
    const base = quote.ask ?? last;
    const cushion = base * (this.params.entryOffsetBps / 10_000);
    return {
      action: 'buy',
      symbol: snapshot.symbol,
      side: 'BUY',
      entryLimitPrice: round2(base + cushion),
      quantity: Math.floor(this.params.tradeBudgetUsd / base),
      stopOffset: round2(last * this.params.stopPercent),
      takeProfitOffset: round2(last * this.params.takeProfitPercent),
      checks,
      snapshot,
    };
  }

  private runChecks(s: SuperSnapshot): RuleCheck[] {
    if (!s.isFiveMinClose) {
      return [{ name: '5min boundary close', passed: false }];
    }
    const series = s.macd5minSeries;
    const s0 = series[0];
    const s1 = series[1];
    const s2 = series[2];
    const s3 = series[3];
    const last = s.quote.last;
    const base = s.quote.ask ?? last;
    const vwap = s.vwap.value;
    return [
      { name: '5min boundary close', passed: true },
      {
        name: '5min histogram positive (last 3 bars)',
        passed:
          !!s0 &&
          !!s1 &&
          !!s2 &&
          s0.histogram > 0 &&
          s1.histogram > 0 &&
          s2.histogram > 0,
      },
      {
        name: '5min histogram crossover (prev bar negative)',
        passed: !!s3 && s3.histogram < 0,
      },
      { name: '5min MACD line > 0', passed: !!s0 && s0.macd > 0 },
      { name: 'VWAP available', passed: Number.isFinite(vwap) },
      { name: 'price > VWAP', passed: Number.isFinite(vwap) && last > vwap },
      {
        name: 'quantity > 0',
        passed: base > 0 && Math.floor(this.params.tradeBudgetUsd / base) > 0,
      },
    ];
  }
}

function isFiveMinClose(timestamp: string | undefined): boolean {
  if (!timestamp) return false;
  const minute = new Date(timestamp).getUTCMinutes();
  return Number.isFinite(minute) && minute % 5 === 4;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
