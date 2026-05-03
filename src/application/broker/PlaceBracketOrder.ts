import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type {
  BracketOrderInput,
  OrderResult,
  OrderSide,
} from '../../domain/broker/BrokerTypes.js';

const VALID_SIDES: OrderSide[] = ['BUY', 'SELL'];

export class PlaceBracketOrder {
  constructor(private readonly broker: BrokerPort) {}

  async execute(input: BracketOrderInput): Promise<OrderResult> {
    if (!input.symbol) throw new Error('symbol is required');
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      throw new Error('quantity must be a positive number');
    }
    if (!VALID_SIDES.includes(input.side)) {
      throw new Error(`side must be one of: ${VALID_SIDES.join(', ')}`);
    }
    if (!Number.isFinite(input.entryLimitPrice) || input.entryLimitPrice <= 0) {
      throw new Error('entryLimitPrice must be a positive number');
    }
    if (!Number.isFinite(input.stopOffset) || input.stopOffset <= 0) {
      throw new Error('stopOffset must be a positive number');
    }
    if (
      !Number.isFinite(input.takeProfitOffset) ||
      input.takeProfitOffset <= 0
    ) {
      throw new Error('takeProfitOffset must be a positive number');
    }
    return this.broker.placeBracketOrder(input);
  }
}
