import { describe, expect, it } from 'vitest';
import type { BrokerPort } from '../../../broker/BrokerPort.js';
import type { IndicatorPort } from '../../../indicators/IndicatorPort.js';
import type { MACD } from '../../../indicators/IndicatorTypes.js';
import {
  SuperDecisionModel,
  type SuperSnapshot,
} from '../../../decision/models/SuperDecisionModel.js';

const DEPS = {
  broker: {} as BrokerPort,
  indicators: {} as IndicatorPort,
};

function macd(histogram: number, macdLine = 1, signal = 0.5): MACD {
  return { macd: macdLine, signal, histogram, timestamp: 't' };
}

function snapshot(overrides: Partial<SuperSnapshot> = {}): SuperSnapshot {
  // Default: passes everything. last=100, vwap=99, [+,+,+,<0], macd>0.
  return {
    symbol: 'AAPL',
    triggerBarTimestamp: '2026-05-10T13:34:00Z', // minute=34, 34%5=4 → boundary
    quote: { symbol: 'AAPL', last: 100, ask: 100, timestamp: 't' },
    macd5minSeries: [macd(0.3), macd(0.2), macd(0.1), macd(-0.1)],
    vwap: { value: 99, timestamp: 't' },
    ...overrides,
  };
}

describe('SuperDecisionModel', () => {
  it('holds when triggerBar is not at a 5-minute boundary close', () => {
    const model = new SuperDecisionModel(DEPS);
    // minute=33, 33%5=3 → not a 5min boundary close
    const result = model.evaluate(
      snapshot({ triggerBarTimestamp: '2026-05-10T13:33:00Z' }),
    );

    expect(result.action).toBe('hold');
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toEqual({
      name: '5min boundary close',
      passed: false,
    });
  });

  it('holds when histogram has 4 positive bars in a row (no crossover)', () => {
    const model = new SuperDecisionModel(DEPS);
    const result = model.evaluate(
      snapshot({
        macd5minSeries: [macd(0.4), macd(0.3), macd(0.2), macd(0.1)],
      }),
    );

    expect(result.action).toBe('hold');
    expect(
      result.checks.find((c) => c.name.startsWith('5min histogram crossover'))
        ?.passed,
    ).toBe(false);
  });

  it('holds when previous bar histogram is exactly zero (not strictly negative)', () => {
    const model = new SuperDecisionModel(DEPS);
    const result = model.evaluate(
      snapshot({
        macd5minSeries: [macd(0.3), macd(0.2), macd(0.1), macd(0)],
      }),
    );

    expect(result.action).toBe('hold');
    expect(
      result.checks.find((c) => c.name.startsWith('5min histogram crossover'))
        ?.passed,
    ).toBe(false);
  });

  it('holds when one of the last 3 histograms is not positive', () => {
    const model = new SuperDecisionModel(DEPS);
    const result = model.evaluate(
      snapshot({
        macd5minSeries: [macd(0.3), macd(-0.05), macd(0.1), macd(-0.1)],
      }),
    );

    expect(result.action).toBe('hold');
    expect(
      result.checks.find((c) => c.name.startsWith('5min histogram positive'))
        ?.passed,
    ).toBe(false);
  });

  it('holds when MACD line is not positive on the most recent 5m bar', () => {
    const model = new SuperDecisionModel(DEPS);
    const result = model.evaluate(
      snapshot({
        macd5minSeries: [macd(0.3, -0.1), macd(0.2), macd(0.1), macd(-0.1)],
      }),
    );

    expect(result.action).toBe('hold');
    expect(
      result.checks.find((c) => c.name === '5min MACD line > 0')?.passed,
    ).toBe(false);
  });

  it('holds when price is not above VWAP', () => {
    const model = new SuperDecisionModel(DEPS);
    const result = model.evaluate(
      snapshot({
        quote: { symbol: 'AAPL', last: 99, ask: 99, timestamp: 't' },
        vwap: { value: 99, timestamp: 't' },
      }),
    );

    expect(result.action).toBe('hold');
    expect(result.checks.find((c) => c.name === 'price > VWAP')?.passed).toBe(
      false,
    );
  });

  it('holds when VWAP is NaN (session not yet bootstrapped)', () => {
    const model = new SuperDecisionModel(DEPS);
    const result = model.evaluate(
      snapshot({ vwap: { value: NaN, timestamp: '' } }),
    );

    expect(result.action).toBe('hold');
    expect(result.checks.find((c) => c.name === 'VWAP available')?.passed).toBe(
      false,
    );
  });

  it('holds when last is too high to afford a single share', () => {
    const model = new SuperDecisionModel(DEPS);
    const result = model.evaluate(
      snapshot({
        quote: { symbol: 'AAPL', last: 30_000, ask: 30_000, timestamp: 't' },
        vwap: { value: 100, timestamp: 't' },
      }),
    );

    expect(result.action).toBe('hold');
    expect(
      result.checks.find((c) => c.name.startsWith('quantity > 0'))?.passed,
    ).toBe(false);
  });

  it('emits buy with dynamic quantity, percentage offsets, and ask-based entry', () => {
    const model = new SuperDecisionModel(DEPS);
    const result = model.evaluate(
      snapshot({
        quote: { symbol: 'AAPL', last: 100, ask: 100.5, timestamp: 't' },
      }),
    );

    expect(result.action).toBe('buy');
    if (result.action !== 'buy') return;
    expect(result.symbol).toBe('AAPL');
    expect(result.side).toBe('BUY');
    // ask=100.5, cushion=100.5 * 10/10000 = 0.1005 → 100.6
    expect(result.entryLimitPrice).toBe(100.6);
    // budget 25000 / ask 100.5 = 248.756... → floor → 248
    expect(result.quantity).toBe(248);
    // last 100 * 0.01 = 1.00
    expect(result.stopOffset).toBe(1);
    // last 100 * 0.025 = 2.50
    expect(result.takeProfitOffset).toBe(2.5);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it('floors quantity (no fractional shares) and rounds offsets to 2 decimals', () => {
    const model = new SuperDecisionModel(DEPS);
    const result = model.evaluate(
      snapshot({
        quote: { symbol: 'AAPL', last: 137.42, ask: 137.5, timestamp: 't' },
        vwap: { value: 130, timestamp: 't' },
      }),
    );

    expect(result.action).toBe('buy');
    if (result.action !== 'buy') return;
    // 25000 / ask 137.5 = 181.818… → floor → 181
    expect(result.quantity).toBe(181);
    // 137.42 * 0.01 = 1.3742 → 1.37
    expect(result.stopOffset).toBe(1.37);
    // 137.42 * 0.025 = 3.4355 → 3.44
    expect(result.takeProfitOffset).toBe(3.44);
  });
});
