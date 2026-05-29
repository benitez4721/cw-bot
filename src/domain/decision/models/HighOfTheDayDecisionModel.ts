import type { BuildSnapshotInput, DecisionModel } from '../DecisionModel.js';
import type { DecisionSignal } from '../DecisionTypes.js';

export interface HighOfTheDayDecisionSnapshot {
  alertName: string | undefined;
}

const ACCEPTED_ALERT_NAME = 'High of the day';
const ALERT_NAME_COLUMN_KEY = 'AlertNameColumn';

export class HighOfTheDayDecisionModel implements DecisionModel<HighOfTheDayDecisionSnapshot> {
  readonly name = 'HighOfTheDay';

  async buildSnapshot(
    input: BuildSnapshotInput,
  ): Promise<HighOfTheDayDecisionSnapshot> {
    const alertName = input.columns?.find(
      (c) => c.key === ALERT_NAME_COLUMN_KEY,
    )?.value;
    return { alertName };
  }

  evaluate(
    snapshot: HighOfTheDayDecisionSnapshot,
  ): DecisionSignal<HighOfTheDayDecisionSnapshot> {
    const passed = snapshot.alertName === ACCEPTED_ALERT_NAME;
    const checks = [{ name: 'alertNameMatch', passed }];
    if (!passed) return { action: 'hold', checks, snapshot };
    // Gate puro: la EventStrategy usa su propia config para
    // entryLimitPrice/quantity/stopOffset/takeProfitOffset; estos campos
    // van como placeholders solo para satisfacer el shape del signal.
    return {
      action: 'buy',
      symbol: '',
      side: 'BUY',
      entryLimitPrice: 0,
      quantity: 0,
      stopOffset: 0,
      takeProfitOffset: 0,
      checks,
      snapshot,
    };
  }
}
