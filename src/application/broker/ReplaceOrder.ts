import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type {
  OrderResult,
  PlaceOrderInput,
} from '../../domain/broker/BrokerTypes.js';

export interface ReplaceOrderInput {
  orderId: string;
  order: PlaceOrderInput;
}

export class ReplaceOrder {
  constructor(private readonly broker: BrokerPort) {}

  async execute({ orderId, order }: ReplaceOrderInput): Promise<OrderResult> {
    if (!orderId) {
      throw new Error('orderId is required');
    }
    return this.broker.replaceOrder({ orderId, order });
  }
}
