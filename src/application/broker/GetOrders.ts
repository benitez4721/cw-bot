import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { OrderWithContext } from '../../domain/broker/BrokerTypes.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';

export interface GetOrdersInput {
  symbol?: string;
}

// Use case detrás de `GET /api/broker/orders`. Concatena las orders de cada
// accountId configurado (cada call al broker es por cuenta) y enriquece con
// el TradeContext correspondiente.
export class GetOrders {
  constructor(
    private readonly broker: BrokerPort,
    private readonly accountIds: readonly string[],
    private readonly tradeContextRepository: TradeContextRepository,
  ) {}

  async execute({ symbol }: GetOrdersInput): Promise<OrderWithContext[]> {
    const ordersByAccount = await Promise.all(
      this.accountIds.map((accountId) =>
        this.broker.getOrders({ symbol, accountId }),
      ),
    );
    const orders = ordersByAccount.flat();
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
