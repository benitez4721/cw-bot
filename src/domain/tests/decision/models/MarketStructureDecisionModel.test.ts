import { describe, expect, it } from 'vitest';
import type { BrokerPort } from '../../../broker/BrokerPort.js';
import type { IndicatorPort } from '../../../indicators/IndicatorPort.js';
import type { MarketStructure } from '../../../indicators/IndicatorTypes.js';
import {
  MarketStructureDecisionModel,
  type MarketStructureSnapshot,
} from '../../../decision/models/MarketStructureDecisionModel.js';

const DEPS = {
  broker: {} as BrokerPort,
  indicators: {} as IndicatorPort,
};

function bullishStructure(
  overrides: Partial<MarketStructure> = {},
): MarketStructure {
  // barCount=106: con lookback=5, el HL "recién confirmado" tiene barIndex=100
  return {
    swings: [
      { label: 'HH', price: 105, barIndex: 90, timestamp: 't90' },
      {
        label: 'HL',
        price: 99,
        barIndex: 100,
        timestamp: 't100',
        emaValue: 100,
      },
    ],
    bullish: true,
    barCount: 106,
    timestamp: 't105',
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<MarketStructureSnapshot> = {},
): MarketStructureSnapshot {
  return {
    symbol: 'AAPL',
    quote: { symbol: 'AAPL', last: 102, timestamp: 't' },
    structure: bullishStructure(),
    atr: { value: 0.5, timestamp: 't' },
    ...overrides,
  };
}

describe('MarketStructureDecisionModel', () => {
  it('emits buy when all checks pass (bullish + HL just confirmed + touched EMA)', () => {
    const model = new MarketStructureDecisionModel(DEPS);
    const result = model.evaluate(snapshot());

    expect(result.action).toBe('buy');
    if (result.action !== 'buy') return;
    expect(result.symbol).toBe('AAPL');
    expect(result.side).toBe('BUY');
    // base=102 (no ask), cushion=102*10/10000=0.102 → entry=102.10
    expect(result.entryLimitPrice).toBe(102.1);
    // stopOffset = entry(102.10) - HL(99) + ATR(0.5)*0.5 = 3.10 + 0.25 = 3.35
    expect(result.stopOffset).toBe(3.35);
    // takeProfitOffset = 3.35 * 2.5 = 8.375 → round2 = 8.38
    expect(result.takeProfitOffset).toBe(8.38);
    // qByRisk = floor(250 / 3.35) = 74; qByBudget = floor(25000 / 102) = 245
    expect(result.quantity).toBe(74);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it('holds when structure is not bullish', () => {
    const model = new MarketStructureDecisionModel(DEPS);
    const result = model.evaluate(
      snapshot({
        structure: bullishStructure({ bullish: false }),
      }),
    );
    expect(result.action).toBe('hold');
    expect(
      result.checks.find((c) => c.name === 'structure bullish')?.passed,
    ).toBe(false);
  });

  it('holds when ATR is null', () => {
    const model = new MarketStructureDecisionModel(DEPS);
    const result = model.evaluate(snapshot({ atr: null }));
    expect(result.action).toBe('hold');
    expect(result.checks.find((c) => c.name === 'ATR available')?.passed).toBe(
      false,
    );
  });

  it('holds when HL is not just confirmed (old swing)', () => {
    const model = new MarketStructureDecisionModel(DEPS);
    const result = model.evaluate(
      snapshot({
        structure: bullishStructure({
          // barCount=106 → justConfirmedIdx=100, but HL is at 80 (old)
          swings: [
            { label: 'HH', price: 105, barIndex: 70, timestamp: 't70' },
            {
              label: 'HL',
              price: 99,
              barIndex: 80,
              timestamp: 't80',
              emaValue: 100,
            },
          ],
        }),
      }),
    );
    expect(result.action).toBe('hold');
    expect(
      result.checks.find((c) => c.name === 'HL just confirmed')?.passed,
    ).toBe(false);
  });

  it('holds when HL did not touch EMA (price > emaValue)', () => {
    const model = new MarketStructureDecisionModel(DEPS);
    const result = model.evaluate(
      snapshot({
        structure: bullishStructure({
          swings: [
            { label: 'HH', price: 105, barIndex: 90, timestamp: 't90' },
            {
              label: 'HL',
              price: 101,
              barIndex: 100,
              timestamp: 't100',
              emaValue: 100,
            },
          ],
        }),
      }),
    );
    expect(result.action).toBe('hold');
    expect(result.checks.find((c) => c.name === 'HL touched EMA')?.passed).toBe(
      false,
    );
  });

  it('holds when HL has no emaValue', () => {
    const model = new MarketStructureDecisionModel(DEPS);
    const result = model.evaluate(
      snapshot({
        structure: bullishStructure({
          swings: [
            { label: 'HH', price: 105, barIndex: 90, timestamp: 't90' },
            { label: 'HL', price: 99, barIndex: 100, timestamp: 't100' },
          ],
        }),
      }),
    );
    expect(result.action).toBe('hold');
    expect(result.checks.find((c) => c.name === 'HL touched EMA')?.passed).toBe(
      false,
    );
  });

  it('holds when no HL exists in swings', () => {
    const model = new MarketStructureDecisionModel(DEPS);
    const result = model.evaluate(
      snapshot({
        structure: bullishStructure({
          swings: [
            { label: 'HH', price: 105, barIndex: 100, timestamp: 't100' },
          ],
        }),
      }),
    );
    expect(result.action).toBe('hold');
  });

  it('uses ask price when available', () => {
    const model = new MarketStructureDecisionModel(DEPS);
    const result = model.evaluate(
      snapshot({
        quote: { symbol: 'AAPL', last: 102, ask: 102.5, timestamp: 't' },
      }),
    );
    expect(result.action).toBe('buy');
    if (result.action !== 'buy') return;
    // ask=102.5, cushion=0.1025 → entry=102.60
    expect(result.entryLimitPrice).toBe(102.6);
  });
});
