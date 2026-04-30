import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { HistoricalOrder } from '../../domain/broker/BrokerTypes.js';

export interface GetHistoricalOrdersInput {
  since: string;
}

export class GetHistoricalOrders {
  constructor(private readonly broker: BrokerPort) {}

  async execute({ since }: GetHistoricalOrdersInput): Promise<HistoricalOrder[]> {
    if (!since) {
      throw new Error('since (ISO 8601 timestamp) is required');
    }
    return this.broker.getHistoricalOrders({ since });
  }
}
