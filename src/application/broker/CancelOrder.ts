import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { OrderResult } from '../../domain/broker/BrokerTypes.js';

export interface CancelOrderInput {
  orderId: string;
}

export class CancelOrder {
  constructor(private readonly broker: BrokerPort) {}

  async execute({ orderId }: CancelOrderInput): Promise<OrderResult> {
    if (!orderId) {
      throw new Error('orderId is required');
    }
    return this.broker.cancelOrder({ orderId });
  }
}
