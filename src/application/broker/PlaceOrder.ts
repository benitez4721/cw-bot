import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { OrderResult, PlaceOrderInput } from '../../domain/broker/BrokerTypes.js';

export class PlaceOrder {
  constructor(private readonly broker: BrokerPort) {}

  async execute(input: PlaceOrderInput): Promise<OrderResult> {
    if (!input.symbol || !input.quantity || !input.side || !input.type) {
      throw new Error('symbol, quantity, side and type are required');
    }
    if (input.quantity <= 0) {
      throw new Error('quantity must be positive');
    }
    if ((input.type === 'Limit' || input.type === 'StopLimit') && input.limitPrice === undefined) {
      throw new Error('limitPrice is required for Limit and StopLimit orders');
    }
    if ((input.type === 'StopMarket' || input.type === 'StopLimit') && input.stopPrice === undefined) {
      throw new Error('stopPrice is required for StopMarket and StopLimit orders');
    }
    return this.broker.placeOrder(input);
  }
}
