import type { DecisionModelPort } from '../../domain/decision/DecisionPort.js';
import type { DecisionSignal } from '../../domain/decision/DecisionTypes.js';
import { logger } from '../../infrastructure/logging/logger.js';

const log = logger.child({ component: 'EvaluateDecision' });

export interface EvaluateDecisionInput {
  symbol: string;
}

export class EvaluateDecision {
  constructor(private readonly model: DecisionModelPort) {}

  async execute({
    symbol,
  }: EvaluateDecisionInput): Promise<DecisionSignal<unknown>> {
    if (!symbol) throw new Error('symbol is required');

    const snapshot = await this.model.buildSnapshot({ symbol });
    log.info({ snapshot }, 'evaluating snapshot');
    return this.model.evaluate({ snapshot });
  }
}
