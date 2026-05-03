import type { IndicatorPort, MACDSeriesInput } from '../../domain/indicators/IndicatorPort.js';
import type { MACD } from '../../domain/indicators/IndicatorTypes.js';

export class GetMACDSeries {
  constructor(private readonly indicators: IndicatorPort) {}

  async execute(input: MACDSeriesInput): Promise<MACD[]> {
    if (!input.symbol) throw new Error('symbol is required');
    if (!input.interval) throw new Error('interval is required');
    if (!Number.isInteger(input.limit) || input.limit <= 0) {
      throw new Error('limit must be a positive integer');
    }
    if (input.fastPeriod !== undefined && (!Number.isInteger(input.fastPeriod) || input.fastPeriod <= 0)) {
      throw new Error('fastPeriod must be a positive integer');
    }
    if (input.slowPeriod !== undefined && (!Number.isInteger(input.slowPeriod) || input.slowPeriod <= 0)) {
      throw new Error('slowPeriod must be a positive integer');
    }
    if (input.signalPeriod !== undefined && (!Number.isInteger(input.signalPeriod) || input.signalPeriod <= 0)) {
      throw new Error('signalPeriod must be a positive integer');
    }
    return this.indicators.getMACDSeries(input);
  }
}
