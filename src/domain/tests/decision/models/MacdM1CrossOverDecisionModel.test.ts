import { describe, expect, it } from 'vitest';
import type { BrokerPort } from '../../../broker/BrokerPort.js';
import type { IndicatorPort } from '../../../indicators/IndicatorPort.js';
import {
  MacdM1CrossOverDecisionModel,
  type MacdM1CrossOverSnapshot,
} from '../../../decision/models/MacdM1CrossOverDecisionModel.js';

const DEPS = {
  broker: {} as BrokerPort,
  indicators: {} as IndicatorPort,
};

function snapshot(
  overrides: Partial<MacdM1CrossOverSnapshot> = {},
): MacdM1CrossOverSnapshot {
  return {
    symbol: 'AAPL',
    quote: { symbol: 'AAPL', last: 100, timestamp: 't' },
    macd5min: { macd: 0.5, signal: 0.2, histogram: 0.3, timestamp: 't' },
    macd1minSeries: [
      { macd: 0.4, signal: 0.1, histogram: 0.3, timestamp: 't0' },
      { macd: 0.2, signal: 0.3, histogram: -0.1, timestamp: 't-1' },
    ],
    vwap1min: { value: 99, timestamp: 't' },
    ...overrides,
  };
}

describe('MacdM1CrossOverDecisionModel', () => {
  it('emits buy with dynamic quantity and percentage offsets when all rules pass', () => {
    const model = new MacdM1CrossOverDecisionModel(DEPS);
    const result = model.evaluate(snapshot());

    expect(result.action).toBe('buy');
    if (result.action !== 'buy') return;
    expect(result.symbol).toBe('AAPL');
    expect(result.side).toBe('BUY');
    // last=100, no ask → base=100, cushion=100 * 10/10000 = 0.1 → 100.10
    expect(result.entryLimitPrice).toBe(100.1);
    // budget 25000 / base 100 = 250
    expect(result.quantity).toBe(250);
    // last 100 * 0.01 = 1.00
    expect(result.stopOffset).toBe(1);
    // last 100 * 0.025 = 2.50
    expect(result.takeProfitOffset).toBe(2.5);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it('uses ask as base for entry and quantity, but last for SL/TP offsets', () => {
    const model = new MacdM1CrossOverDecisionModel(DEPS);
    const result = model.evaluate(
      snapshot({
        quote: { symbol: 'AAPL', last: 100, ask: 100.5, timestamp: 't' },
      }),
    );

    expect(result.action).toBe('buy');
    if (result.action !== 'buy') return;
    // ask=100.5, cushion=100.5 * 10/10000 = 0.1005 → 100.60
    expect(result.entryLimitPrice).toBe(100.6);
    // budget 25000 / ask 100.5 = 248.756… → floor → 248
    expect(result.quantity).toBe(248);
    // SL/TP use last (100), not ask
    expect(result.stopOffset).toBe(1);
    expect(result.takeProfitOffset).toBe(2.5);
  });

  it('holds when price is too high to afford a single share within the budget', () => {
    const model = new MacdM1CrossOverDecisionModel(DEPS);
    const result = model.evaluate(
      snapshot({
        quote: { symbol: 'AAPL', last: 30_000, ask: 30_000, timestamp: 't' },
        vwap1min: { value: 100, timestamp: 't' },
      }),
    );

    expect(result.action).toBe('hold');
    expect(result.checks.find((c) => c.name === 'quantity > 0')?.passed).toBe(
      false,
    );
  });

  it('holds when 5min MACD is not positive', () => {
    const model = new MacdM1CrossOverDecisionModel(DEPS);
    const result = model.evaluate(
      snapshot({
        macd5min: { macd: -0.1, signal: 0, histogram: 0.3, timestamp: 't' },
      }),
    );

    expect(result.action).toBe('hold');
    expect(result.checks.find((c) => c.name === '5min MACD > 0')?.passed).toBe(
      false,
    );
  });

  it('holds when 5min histogram is not positive', () => {
    const model = new MacdM1CrossOverDecisionModel(DEPS);
    const result = model.evaluate(
      snapshot({
        macd5min: { macd: 0.5, signal: 0.4, histogram: -0.05, timestamp: 't' },
      }),
    );

    expect(result.action).toBe('hold');
    expect(
      result.checks.find((c) => c.name === '5min histogram > 0')?.passed,
    ).toBe(false);
  });

  it('holds when 1min MACD is not positive', () => {
    const model = new MacdM1CrossOverDecisionModel(DEPS);
    const result = model.evaluate(
      snapshot({
        macd1minSeries: [
          { macd: -0.1, signal: 0, histogram: 0.3, timestamp: 't0' },
          { macd: 0.2, signal: 0.3, histogram: -0.1, timestamp: 't-1' },
        ],
      }),
    );

    expect(result.action).toBe('hold');
    expect(result.checks.find((c) => c.name === '1min MACD > 0')?.passed).toBe(
      false,
    );
  });

  it('holds when histogram already positive in previous bar (no crossover)', () => {
    const model = new MacdM1CrossOverDecisionModel(DEPS);
    const result = model.evaluate(
      snapshot({
        macd1minSeries: [
          { macd: 0.4, signal: 0.1, histogram: 0.3, timestamp: 't0' },
          { macd: 0.3, signal: 0.2, histogram: 0.1, timestamp: 't-1' },
        ],
      }),
    );

    expect(result.action).toBe('hold');
    expect(
      result.checks.find((c) => c.name === '1min histogram bullish crossover')
        ?.passed,
    ).toBe(false);
  });

  it('holds when current histogram is negative (bearish crossover)', () => {
    const model = new MacdM1CrossOverDecisionModel(DEPS);
    const result = model.evaluate(
      snapshot({
        macd1minSeries: [
          { macd: 0.4, signal: 0.5, histogram: -0.1, timestamp: 't0' },
          { macd: 0.3, signal: 0.2, histogram: 0.1, timestamp: 't-1' },
        ],
      }),
    );

    expect(result.action).toBe('hold');
    expect(
      result.checks.find((c) => c.name === '1min histogram bullish crossover')
        ?.passed,
    ).toBe(false);
  });

  it('holds when price is below VWAP', () => {
    const model = new MacdM1CrossOverDecisionModel(DEPS);
    const result = model.evaluate(
      snapshot({
        quote: { symbol: 'AAPL', last: 99.5, timestamp: 't' },
        vwap1min: { value: 100, timestamp: 't' },
      }),
    );

    expect(result.action).toBe('hold');
    expect(
      result.checks.find((c) => c.name === 'price > VWAP (1min)')?.passed,
    ).toBe(false);
  });

  it('holds when crossover magnitude is below the configured threshold', () => {
    const model = new MacdM1CrossOverDecisionModel(DEPS);
    // current - previous = 0.001 - (-0.0005) = 0.0015 < 0.002 threshold.
    // Sign-based crossover still passes (current>0, previous<0), so this
    // exercises the magnitude check in isolation.
    const result = model.evaluate(
      snapshot({
        macd1minSeries: [
          { macd: 0.4, signal: 0.399, histogram: 0.001, timestamp: 't0' },
          { macd: 0.3, signal: 0.3005, histogram: -0.0005, timestamp: 't-1' },
        ],
      }),
    );

    expect(result.action).toBe('hold');
    expect(
      result.checks.find((c) => c.name.startsWith('1min histogram crossover'))
        ?.passed,
    ).toBe(false);
    expect(
      result.checks.find((c) => c.name === '1min histogram bullish crossover')
        ?.passed,
    ).toBe(true);
  });

  it('holds when 1min series has fewer than 2 points', () => {
    const model = new MacdM1CrossOverDecisionModel(DEPS);
    const result = model.evaluate(
      snapshot({
        macd1minSeries: [
          { macd: 0.4, signal: 0.1, histogram: 0.3, timestamp: 't0' },
        ],
      }),
    );

    expect(result.action).toBe('hold');
    expect(
      result.checks.find((c) => c.name === '1min histogram bullish crossover')
        ?.passed,
    ).toBe(false);
  });
});
