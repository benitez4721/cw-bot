import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type {
  BracketOrderResult,
  OrderSide,
  TrailingBracketOrderInput,
} from '../../domain/broker/BrokerTypes.js';

const VALID_SIDES: OrderSide[] = ['BUY', 'SELL'];

export class PlaceTrailingBracketOrder {
  constructor(private readonly broker: BrokerPort) {}

  async execute(input: TrailingBracketOrderInput): Promise<BracketOrderResult> {
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
    if (
      !Number.isFinite(input.trailingStopPercent) ||
      input.trailingStopPercent <= 0
    ) {
      throw new Error('trailingStopPercent must be a positive number');
    }
    return this.broker.placeTrailingBracketOrder(input);
  }
}
