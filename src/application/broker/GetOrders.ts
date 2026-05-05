import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { OrderWithContext } from '../../domain/broker/BrokerTypes.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';

export interface GetOrdersInput {
  symbol?: string;
}

export class GetOrders {
  constructor(
    private readonly broker: BrokerPort,
    private readonly tradeContextRepository: TradeContextRepository,
  ) {}

  async execute({ symbol }: GetOrdersInput): Promise<OrderWithContext[]> {
    const orders = await this.broker.getOrders({ symbol });
    if (orders.length === 0) return [];

    const ids = orders.map((o) => o.id);
    const contexts = await this.tradeContextRepository.getByOrderIds(ids);

    return orders.map((order) => {
      const context = contexts.get(order.id);
      if (!context) return order;
      return { ...order, context };
    });
  }
}
