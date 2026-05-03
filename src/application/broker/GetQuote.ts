import type { BrokerPort, GetQuoteInput } from '../../domain/broker/BrokerPort.js';
import type { Quote } from '../../domain/broker/BrokerTypes.js';

export class GetQuote {
  constructor(private readonly broker: BrokerPort) {}

  async execute(input: GetQuoteInput): Promise<Quote> {
    if (!input.symbol || typeof input.symbol !== 'string') {
      throw new Error('symbol is required');
    }
    return this.broker.getQuote(input);
  }
}
