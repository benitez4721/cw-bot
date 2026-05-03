import type {
  EMAInput,
  IndicatorPort,
} from '../../domain/indicators/IndicatorPort.js';
import type { EMA } from '../../domain/indicators/IndicatorTypes.js';

export class GetEMA {
  constructor(private readonly indicators: IndicatorPort) {}

  async execute(input: EMAInput): Promise<EMA> {
    if (!input.symbol) throw new Error('symbol is required');
    if (!input.interval) throw new Error('interval is required');
    if (!Number.isInteger(input.period) || input.period <= 0) {
      throw new Error('period must be a positive integer');
    }
    return this.indicators.getEMA(input);
  }
}
