import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { Order } from '../../domain/broker/BrokerTypes.js';

export interface GetOrdersInput {
  symbol?: string;
}

export class GetOrders {
  constructor(private readonly broker: BrokerPort) {}

  async execute({ symbol }: GetOrdersInput): Promise<Order[]> {
    return this.broker.getOrders({ symbol });
  }
}
