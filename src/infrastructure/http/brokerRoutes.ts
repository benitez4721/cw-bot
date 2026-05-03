import type { FastifyPluginAsync } from 'fastify';
import type { GetOrders } from '../../application/broker/GetOrders.js';

interface BrokerRoutesOptions {
  getOrders: GetOrders;
}

export const brokerRoutes: FastifyPluginAsync<BrokerRoutesOptions> = async (
  server,
  opts,
) => {
  server.get('/api/broker/orders', async () => {
    const orders = await opts.getOrders.execute({});
    return { orders };
  });
};
