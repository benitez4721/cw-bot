import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type {
  OrderDuration,
  OrderResult,
  OrderRoute,
  OrderSide,
  PlaceLimitOrderInput,
} from '../../domain/broker/BrokerTypes.js';
import type { MetricsPort } from '../../domain/metrics/MetricsPort.js';

const VALID_SIDES: OrderSide[] = ['BUY', 'SELL'];
const VALID_DURATIONS: OrderDuration[] = ['DAY', 'DYP'];
const VALID_ROUTES: OrderRoute[] = ['Intelligent', 'ARCA', 'BATS'];

// Wrapper de broker.placeLimitOrder analogo a PlaceBracketOrder. Valida el
// input y registra el resultado en metricas. No conoce el concepto de "stop"
// ni "take profit": el caller decide los parametros de la orden segun la
// sesion (pre usa duration: 'DYP' + route: 'ARCA'; RTH no usa este wrapper).
export class PlaceLimitOrder {
  constructor(
    private readonly broker: BrokerPort,
    private readonly metrics: MetricsPort,
  ) {}

  async execute(input: PlaceLimitOrderInput): Promise<OrderResult> {
    if (!input.symbol) throw new Error('symbol is required');
    if (!Number.isFinite(input.quantity) || input.quantity <= 0) {
      throw new Error('quantity must be a positive number');
    }
    if (!VALID_SIDES.includes(input.side)) {
      throw new Error(`side must be one of: ${VALID_SIDES.join(', ')}`);
    }
    if (!Number.isFinite(input.limitPrice) || input.limitPrice <= 0) {
      throw new Error('limitPrice must be a positive number');
    }
    if (!VALID_DURATIONS.includes(input.duration)) {
      throw new Error(`duration must be one of: ${VALID_DURATIONS.join(', ')}`);
    }
    if (input.route !== undefined && !VALID_ROUTES.includes(input.route)) {
      throw new Error(`route must be one of: ${VALID_ROUTES.join(', ')}`);
    }
    if (!input.accountId) throw new Error('accountId is required');

    const result = await this.broker.placeLimitOrder(input);
    this.metrics.recordOrderResult(result.status);
    return result;
  }
}
