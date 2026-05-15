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

// ChartsWatcher scanner config that feeds this model's watchlist. Part of
// the model's definition (RVOL filter is applied upstream by CW), not a
// per-environment toggle.
export const SUPER_CW_CONFIG_ID = '69f6bec1f52a7e93e345cd0c';

export interface SuperSnapshot {
  symbol: string;
  triggerBarTimestamp?: string;
  quote: Quote;
  macd5minSeries: MACD[];
  vwap: VWAP;
}

const PARAMS = {
  tradeBudgetUsd: 25_000,
  stopPercent: 0.01,
  takeProfitPercent: 0.025,
  entryOffsetBps: 10,
} as const;
export class SuperDecisionModel implements DecisionModel<SuperSnapshot> {
  readonly name = 'Super';
  private readonly broker: BrokerPort;
  private readonly indicators: IndicatorPort;

  constructor(deps: { broker: BrokerPort; indicators: IndicatorPort }) {
    this.broker = deps.broker;
    this.indicators = deps.indicators;
  }

  async buildSnapshot({
    symbol,
    triggerBar,
  }: BuildSnapshotInput): Promise<SuperSnapshot> {
    const triggerBarTimestamp = triggerBar?.timestamp;

    if (!isFiveMinClose(triggerBarTimestamp)) {
      return {
        symbol,
        triggerBarTimestamp,
        quote: { symbol: '', last: 0, timestamp: '' },
        macd5minSeries: [],
        vwap: { value: NaN, timestamp: '' },
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
      quote,
      macd5minSeries,
      vwap,
    };
  }

  evaluate(snapshot: SuperSnapshot): DecisionSignal<SuperSnapshot> {
    const checks = this.runChecks(snapshot);
    if (checks.some((c) => !c.passed)) {
      return { action: 'hold', checks, snapshot };
    }
    const { quote } = snapshot;
    const last = quote.last;
    const base = quote.ask ?? last;
    const cushion = base * (PARAMS.entryOffsetBps / 10_000);
    return {
      action: 'buy',
      symbol: snapshot.symbol,
      side: 'BUY',
      entryLimitPrice: round2(base + cushion),
      quantity: Math.floor(PARAMS.tradeBudgetUsd / base),
      stopOffset: round2(last * PARAMS.stopPercent),
      takeProfitOffset: round2(last * PARAMS.takeProfitPercent),
      checks,
      snapshot,
    };
  }

  private runChecks(s: SuperSnapshot): RuleCheck[] {
    if (!isFiveMinClose(s.triggerBarTimestamp)) {
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
        passed: base > 0 && Math.floor(PARAMS.tradeBudgetUsd / base) > 0,
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
