import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { DecisionModelPort } from '../../domain/decision/DecisionPort.js';
import type {
  DecisionSignal,
  MarketSnapshot,
} from '../../domain/decision/DecisionTypes.js';
import type { IndicatorPort } from '../../domain/indicators/IndicatorPort.js';
import { logger } from '../../infrastructure/logging/logger.js';

const log = logger.child({ component: 'EvaluateDecision' });

export interface EvaluateDecisionInput {
  symbol: string;
}

export class EvaluateDecision {
  constructor(
    private readonly model: DecisionModelPort,
    private readonly indicators: IndicatorPort,
    private readonly broker: BrokerPort,
  ) {}

  async execute({ symbol }: EvaluateDecisionInput): Promise<DecisionSignal> {
    if (!symbol) throw new Error('symbol is required');

    const snapshot = await this.buildSnapshot(symbol);
    log.info({ snapshot }, 'evaluating snapshot');
    return this.model.evaluate({ snapshot });
  }

  private async buildSnapshot(symbol: string): Promise<MarketSnapshot> {
    const [quote, macd5min, macd1minSeries, vwap1min] = await Promise.all([
      this.broker.getQuote({ symbol }),
      this.indicators.getMACD({ symbol, interval: '5min' }),
      this.indicators.getMACDSeries({ symbol, interval: '1min', limit: 2 }),
      this.indicators.getVWAP({ symbol, interval: '1min' }),
    ]);
    return { symbol, quote, macd5min, macd1minSeries, vwap1min };
  }
}
