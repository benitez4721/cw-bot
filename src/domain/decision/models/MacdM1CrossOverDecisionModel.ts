import type { BrokerPort } from '../../broker/BrokerPort.js';
import type { Quote } from '../../broker/BrokerTypes.js';
import type { BuildSnapshotInput, DecisionModel } from '../DecisionModel.js';
import type { DecisionSignal, RuleCheck } from '../DecisionTypes.js';
import { CacheUnderfilledError } from '../../indicators/IndicatorErrors.js';
import type { IndicatorPort } from '../../indicators/IndicatorPort.js';
import type { ATR, MACD, VWAP } from '../../indicators/IndicatorTypes.js';

export interface MacdM1CrossOverSnapshot {
  symbol: string;
  quote: Quote;
  macd5min: MACD;
  macd1minSeries: MACD[];
  vwap1min: VWAP;
  atr5min: ATR | null;
}

const PARAMS = {
  tradeBudgetUsd: 25_000,
  // Cap de pérdida por trade = 1% del budget (~250 USD). Iguala el techo
  // de riesgo de Super, pero el stop se sigue anclando al ATR — la cuota
  // se respeta achicando la quantity, no el ancho del stop.
  maxRiskPercent: 0.01,
  entryOffsetBps: 10,
  minHistogram1minCrossoverDelta: 0.002,
  // Stop/TP basados en volatilidad. kStop=2 deja el stop fuera del ruido
  // típico; rTakeProfit=2.5 preserva el R:R 2.5:1 independiente del símbolo.
  atrPeriod: 14,
  kStop: 2.0,
  rTakeProfit: 2.5,
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
    accountId,
  }: BuildSnapshotInput): Promise<MacdM1CrossOverSnapshot> {
    const [quote, macd5min, macd1minSeries, vwap1min, atr5min] =
      await Promise.all([
        this.broker.getQuote({ symbol, accountId }),
        this.indicators.getMACD({ symbol, interval: '5min' }),
        this.indicators.getMACDSeries({ symbol, interval: '1min', limit: 2 }),
        this.indicators.getVWAP({ symbol, interval: '1min' }),
        this.indicators
          .getATR({ symbol, interval: '5min', period: PARAMS.atrPeriod })
          .catch((err: unknown): ATR | null => {
            if (err instanceof CacheUnderfilledError) return null;
            throw err;
          }),
      ]);
    return { symbol, quote, macd5min, macd1minSeries, vwap1min, atr5min };
  }

  evaluate(
    snapshot: MacdM1CrossOverSnapshot,
  ): DecisionSignal<MacdM1CrossOverSnapshot> {
    const checks = this.runChecks(snapshot);
    if (checks.some((c) => !c.passed)) {
      return { action: 'hold', checks, snapshot };
    }
    const last = snapshot.quote.last;
    const base = snapshot.quote.ask ?? last;
    const cushion = base * (PARAMS.entryOffsetBps / 10_000);
    // Non-null gracias al check 'ATR available' validado arriba.
    const stopOffset = round2(PARAMS.kStop * snapshot.atr5min!.value);
    const takeProfitOffset = round2(PARAMS.rTakeProfit * stopOffset);
    return {
      action: 'buy',
      symbol: snapshot.symbol,
      side: 'BUY',
      entryLimitPrice: round2(base + cushion),
      quantity: computeQuantity(base, snapshot.atr5min),
      stopOffset,
      takeProfitOffset,
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
    const base = s.quote.ask ?? s.quote.last;

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
      {
        name: 'quantity > 0',
        passed: computeQuantity(base, s.atr5min) > 0,
      },
      { name: 'ATR available', passed: !!s.atr5min },
    ];
  }
}

function computeQuantity(base: number, atr: ATR | null): number {
  if (atr === null || atr.value <= 0 || base <= 0) return 0;
  const stopOffset = round2(PARAMS.kStop * atr.value);
  if (stopOffset <= 0) return 0;
  const maxRiskUsd = PARAMS.tradeBudgetUsd * PARAMS.maxRiskPercent;
  const qByRisk = Math.floor(maxRiskUsd / stopOffset);
  const qByBudget = Math.floor(PARAMS.tradeBudgetUsd / base);
  return Math.min(qByRisk, qByBudget);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
