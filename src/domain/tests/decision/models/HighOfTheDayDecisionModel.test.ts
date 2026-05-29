import { describe, expect, it } from 'vitest';
import { HighOfTheDayDecisionModel } from '../../../decision/models/HighOfTheDayDecisionModel.js';

describe('HighOfTheDayDecisionModel', () => {
  it('returns buy when AlertNameColumn value is exactly "High of the day"', async () => {
    const model = new HighOfTheDayDecisionModel();
    const snapshot = await model.buildSnapshot({
      symbol: 'AAPL',
      accountId: 'SIM1',
      columns: [
        { key: 'SymbolColumn', value: 'AAPL' },
        { key: 'AlertNameColumn', value: 'High of the day' },
      ],
    });
    const signal = model.evaluate(snapshot);
    expect(signal.action).toBe('buy');
    expect(signal.checks).toEqual([{ name: 'alertNameMatch', passed: true }]);
  });

  it('returns hold when AlertNameColumn value does not match', async () => {
    const model = new HighOfTheDayDecisionModel();
    const snapshot = await model.buildSnapshot({
      symbol: 'AAPL',
      accountId: 'SIM1',
      columns: [{ key: 'AlertNameColumn', value: 'Low of the day' }],
    });
    const signal = model.evaluate(snapshot);
    expect(signal.action).toBe('hold');
    expect(signal.checks).toEqual([{ name: 'alertNameMatch', passed: false }]);
  });

  it('returns hold when AlertNameColumn is missing from columns (fail-safe)', async () => {
    const model = new HighOfTheDayDecisionModel();
    const snapshot = await model.buildSnapshot({
      symbol: 'AAPL',
      accountId: 'SIM1',
      columns: [{ key: 'SymbolColumn', value: 'AAPL' }],
    });
    const signal = model.evaluate(snapshot);
    expect(signal.action).toBe('hold');
    expect(snapshot.alertName).toBeUndefined();
  });

  it('returns hold when columns is undefined', async () => {
    const model = new HighOfTheDayDecisionModel();
    const snapshot = await model.buildSnapshot({
      symbol: 'AAPL',
      accountId: 'SIM1',
    });
    const signal = model.evaluate(snapshot);
    expect(signal.action).toBe('hold');
    expect(snapshot.alertName).toBeUndefined();
  });

  it('is case-sensitive on the alert name (rejects "high of the day")', async () => {
    const model = new HighOfTheDayDecisionModel();
    const snapshot = await model.buildSnapshot({
      symbol: 'AAPL',
      accountId: 'SIM1',
      columns: [{ key: 'AlertNameColumn', value: 'high of the day' }],
    });
    const signal = model.evaluate(snapshot);
    expect(signal.action).toBe('hold');
  });
});
