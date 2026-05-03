import { describe, expect, it } from 'vitest';
import type { MarketSnapshot } from '../../domain/decision/DecisionPort.js';
import { TechnicalDecisionModel } from './TechnicalDecisionModel.js';

const PARAMS = {
  quantity: 2000,
  entryOffset: 0.05,
  stopOffset: 0.2,
  takeProfitOffset: 0.35,
};

function snapshot(overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  return {
    symbol: 'AAPL',
    quote: { symbol: 'AAPL', last: 101, timestamp: 't' },
    macd5min: { macd: 0.5, signal: 0.2, histogram: 0.3, timestamp: 't' },
    macd1minSeries: [
      { macd: 0.4, signal: 0.1, histogram: 0.3, timestamp: 't0' },
      { macd: 0.2, signal: 0.3, histogram: -0.1, timestamp: 't-1' },
    ],
    vwap1min: { value: 100, timestamp: 't' },
    ...overrides,
  };
}

describe('TechnicalDecisionModel', () => {
  it('emits buy with symbol, side and entry price when all five rules pass', () => {
    const model = new TechnicalDecisionModel(PARAMS);
    const result = model.evaluate({ snapshot: snapshot() });

    expect(result.action).toBe('buy');
    if (result.action !== 'buy') return;
    expect(result.symbol).toBe('AAPL');
    expect(result.side).toBe('BUY');
    expect(result.entryLimitPrice).toBe(101.05);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it('exposes orderConfig derived from constructor params', () => {
    const model = new TechnicalDecisionModel(PARAMS);
    expect(model.orderConfig).toEqual({
      quantity: 2000,
      stopOffset: 0.2,
      takeProfitOffset: 0.35,
    });
  });

  it('holds when 5min MACD is not positive', () => {
    const model = new TechnicalDecisionModel(PARAMS);
    const result = model.evaluate({
      snapshot: snapshot({ macd5min: { macd: -0.1, signal: 0, histogram: 0.3, timestamp: 't' } }),
    });

    expect(result.action).toBe('hold');
    expect(result.checks.find((c) => c.name === '5min MACD > 0')?.passed).toBe(false);
  });

  it('holds when 5min histogram is not positive', () => {
    const model = new TechnicalDecisionModel(PARAMS);
    const result = model.evaluate({
      snapshot: snapshot({ macd5min: { macd: 0.5, signal: 0.4, histogram: -0.05, timestamp: 't' } }),
    });

    expect(result.action).toBe('hold');
    expect(result.checks.find((c) => c.name === '5min histogram > 0')?.passed).toBe(false);
  });

  it('holds when 1min MACD is not positive', () => {
    const model = new TechnicalDecisionModel(PARAMS);
    const result = model.evaluate({
      snapshot: snapshot({
        macd1minSeries: [
          { macd: -0.1, signal: 0, histogram: 0.3, timestamp: 't0' },
          { macd: 0.2, signal: 0.3, histogram: -0.1, timestamp: 't-1' },
        ],
      }),
    });

    expect(result.action).toBe('hold');
    expect(result.checks.find((c) => c.name === '1min MACD > 0')?.passed).toBe(false);
  });

  it('holds when histogram already positive in previous bar (no crossover)', () => {
    const model = new TechnicalDecisionModel(PARAMS);
    const result = model.evaluate({
      snapshot: snapshot({
        macd1minSeries: [
          { macd: 0.4, signal: 0.1, histogram: 0.3, timestamp: 't0' },
          { macd: 0.3, signal: 0.2, histogram: 0.1, timestamp: 't-1' },
        ],
      }),
    });

    expect(result.action).toBe('hold');
    expect(result.checks.find((c) => c.name === '1min histogram bullish crossover')?.passed).toBe(
      false,
    );
  });

  it('holds when current histogram is negative (bearish crossover)', () => {
    const model = new TechnicalDecisionModel(PARAMS);
    const result = model.evaluate({
      snapshot: snapshot({
        macd1minSeries: [
          { macd: 0.4, signal: 0.5, histogram: -0.1, timestamp: 't0' },
          { macd: 0.3, signal: 0.2, histogram: 0.1, timestamp: 't-1' },
        ],
      }),
    });

    expect(result.action).toBe('hold');
    expect(result.checks.find((c) => c.name === '1min histogram bullish crossover')?.passed).toBe(
      false,
    );
  });

  it('holds when price is below VWAP', () => {
    const model = new TechnicalDecisionModel(PARAMS);
    const result = model.evaluate({
      snapshot: snapshot({
        quote: { symbol: 'AAPL', last: 99.5, timestamp: 't' },
        vwap1min: { value: 100, timestamp: 't' },
      }),
    });

    expect(result.action).toBe('hold');
    expect(result.checks.find((c) => c.name === 'price > VWAP (1min)')?.passed).toBe(false);
  });

  it('holds when 1min series has fewer than 2 points', () => {
    const model = new TechnicalDecisionModel(PARAMS);
    const result = model.evaluate({
      snapshot: snapshot({
        macd1minSeries: [{ macd: 0.4, signal: 0.1, histogram: 0.3, timestamp: 't0' }],
      }),
    });

    expect(result.action).toBe('hold');
    expect(result.checks.find((c) => c.name === '1min histogram bullish crossover')?.passed).toBe(
      false,
    );
  });
});
