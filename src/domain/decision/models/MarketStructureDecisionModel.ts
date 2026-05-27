import type { BrokerPort } from '../../broker/BrokerPort.js';
import type { Quote } from '../../broker/BrokerTypes.js';
import type { BuildSnapshotInput, DecisionModel } from '../DecisionModel.js';
import type { DecisionSignal, RuleCheck } from '../DecisionTypes.js';
import { CacheUnderfilledError } from '../../indicators/IndicatorErrors.js';
import type { IndicatorPort } from '../../indicators/IndicatorPort.js';
import type {
  ATR,
  MarketStructure,
  SwingPoint,
} from '../../indicators/IndicatorTypes.js';

export interface MarketStructureSnapshot {
  symbol: string;
  quote: Quote;
  structure: MarketStructure;
  atr: ATR | null;
}

const PARAMS = {
  lookback: 3,
  emaPeriod: 18,
  tradeBudgetUsd: 25_000,
  maxRiskPercent: 0.01,
  entryOffsetBps: 10,
  stopBufferMultiplier: 0.5,
  rTakeProfit: 2.5,
  atrPeriod: 14,
} as const;

export class MarketStructureDecisionModel implements DecisionModel<MarketStructureSnapshot> {
  readonly name = 'MarketStructure';
  private readonly broker: BrokerPort;
  private readonly indicators: IndicatorPort;

  constructor(deps: { broker: BrokerPort; indicators: IndicatorPort }) {
    this.broker = deps.broker;
    this.indicators = deps.indicators;
  }

  async buildSnapshot({
    symbol,
    accountId,
  }: BuildSnapshotInput): Promise<MarketStructureSnapshot> {
    const [quote, structure, atr] = await Promise.all([
      this.broker.getQuote({ symbol, accountId }),
      this.indicators.getMarketStructure({
        symbol,
        interval: '1min',
        lookback: PARAMS.lookback,
        emaPeriod: PARAMS.emaPeriod,
      }),
      this.indicators
        .getATR({ symbol, interval: '1min', period: PARAMS.atrPeriod })
        .catch((err: unknown): ATR | null => {
          if (err instanceof CacheUnderfilledError) return null;
          throw err;
        }),
    ]);
    return { symbol, quote, structure, atr };
  }

  evaluate(
    snapshot: MarketStructureSnapshot,
  ): DecisionSignal<MarketStructureSnapshot> {
    const checks = this.runChecks(snapshot);
    if (checks.some((c) => !c.passed)) {
      return { action: 'hold', checks, snapshot };
    }

    const hl = findLatestHL(snapshot.structure.swings)!;
    const base = snapshot.quote.ask ?? snapshot.quote.last;
    const cushion = base * (PARAMS.entryOffsetBps / 10_000);
    const entry = round2(base + cushion);
    const atrValue = snapshot.atr!.value;
    const stopOffset = round2(
      entry - hl.price + atrValue * PARAMS.stopBufferMultiplier,
    );
    const takeProfitOffset = round2(PARAMS.rTakeProfit * stopOffset);

    return {
      action: 'buy',
      symbol: snapshot.symbol,
      side: 'BUY',
      entryLimitPrice: entry,
      quantity: computeQuantity(base, stopOffset),
      stopOffset,
      takeProfitOffset,
      checks,
      snapshot,
    };
  }

  private runChecks(s: MarketStructureSnapshot): RuleCheck[] {
    const { structure, atr } = s;
    const hl = findLatestHL(structure.swings);
    const justConfirmedIdx = structure.barCount - 1 - PARAMS.lookback;

    return [
      { name: 'structure bullish', passed: structure.bullish },
      { name: 'ATR available', passed: atr !== null },
      {
        name: 'HL just confirmed',
        passed: hl !== null && hl.barIndex === justConfirmedIdx,
      },
      {
        name: 'HL touched EMA',
        passed:
          hl !== null && hl.emaValue !== undefined && hl.price <= hl.emaValue,
      },
      {
        name: 'quantity > 0',
        passed:
          atr !== null &&
          computeQuantity(
            s.quote.ask ?? s.quote.last,
            round2(
              (s.quote.ask ?? s.quote.last) -
                (hl?.price ?? 0) +
                atr.value * PARAMS.stopBufferMultiplier,
            ),
          ) > 0,
      },
    ];
  }
}

function findLatestHL(swings: SwingPoint[]): SwingPoint | null {
  for (let i = swings.length - 1; i >= 0; i--) {
    if (swings[i].label === 'HL') return swings[i];
  }
  return null;
}

function computeQuantity(base: number, stopOffset: number): number {
  if (base <= 0 || stopOffset <= 0) return 0;
  const maxRiskUsd = PARAMS.tradeBudgetUsd * PARAMS.maxRiskPercent;
  const qByRisk = Math.floor(maxRiskUsd / stopOffset);
  const qByBudget = Math.floor(PARAMS.tradeBudgetUsd / base);
  return Math.min(qByRisk, qByBudget);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
