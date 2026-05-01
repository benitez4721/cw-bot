import type { IndicatorPort, VWAPInput } from '../../domain/indicators/IndicatorPort.js';
import type { IntradayInterval, VWAP } from '../../domain/indicators/IndicatorTypes.js';

const VALID_VWAP_INTERVALS: IntradayInterval[] = ['1min', '5min', '15min', '30min', '60min'];

export class GetVWAP {
  constructor(private readonly indicators: IndicatorPort) {}

  async execute(input: VWAPInput): Promise<VWAP> {
    if (!input.symbol) throw new Error('symbol is required');
    if (!input.interval || !VALID_VWAP_INTERVALS.includes(input.interval)) {
      throw new Error(`interval must be one of: ${VALID_VWAP_INTERVALS.join(', ')}`);
    }
    return this.indicators.getVWAP(input);
  }
}
