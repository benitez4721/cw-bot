import type { FastifyInstance } from 'fastify';
import type { PlaceOrder } from '../../application/broker/PlaceOrder.js';
import type { CancelOrder } from '../../application/broker/CancelOrder.js';
import type { ReplaceOrder } from '../../application/broker/ReplaceOrder.js';
import type { GetBalances } from '../../application/broker/GetBalances.js';
import type { GetPositions } from '../../application/broker/GetPositions.js';
import type { GetOrders } from '../../application/broker/GetOrders.js';
import type { GetHistoricalOrders } from '../../application/broker/GetHistoricalOrders.js';
import type { GetQuote } from '../../application/broker/GetQuote.js';
import type { PlaceBracketOrder } from '../../application/broker/PlaceBracketOrder.js';
import type {
  BracketOrderInput,
  OrderSide,
  OrderType,
  PlaceOrderInput,
} from '../../domain/broker/BrokerTypes.js';

const VALID_TYPES: OrderType[] = ['Market', 'Limit', 'StopMarket', 'StopLimit'];
const VALID_SIDES: OrderSide[] = ['BUY', 'SELL'];

interface PlaceOrderBody {
  symbol?: string;
  quantity?: number;
  side?: string;
  type?: string;
  limitPrice?: number;
  stopPrice?: number;
}

interface BracketOrderBody {
  symbol?: string;
  quantity?: number;
  side?: string;
  entryLimitPrice?: number;
  stopOffset?: number;
  takeProfitOffset?: number;
}

function validateBracketOrderBody(
  body: BracketOrderBody,
): { ok: true; input: BracketOrderInput } | { ok: false; error: string } {
  if (!body.symbol || typeof body.symbol !== 'string') {
    return { ok: false, error: 'symbol is required (string)' };
  }
  if (typeof body.quantity !== 'number' || body.quantity <= 0) {
    return { ok: false, error: 'quantity must be a positive number' };
  }
  if (!body.side || !VALID_SIDES.includes(body.side as OrderSide)) {
    return { ok: false, error: `side must be one of: ${VALID_SIDES.join(', ')}` };
  }
  if (typeof body.entryLimitPrice !== 'number' || body.entryLimitPrice <= 0) {
    return { ok: false, error: 'entryLimitPrice must be a positive number' };
  }
  if (typeof body.stopOffset !== 'number' || body.stopOffset <= 0) {
    return { ok: false, error: 'stopOffset must be a positive number' };
  }
  if (typeof body.takeProfitOffset !== 'number' || body.takeProfitOffset <= 0) {
    return { ok: false, error: 'takeProfitOffset must be a positive number' };
  }
  return {
    ok: true,
    input: {
      symbol: body.symbol,
      quantity: body.quantity,
      side: body.side as OrderSide,
      entryLimitPrice: body.entryLimitPrice,
      stopOffset: body.stopOffset,
      takeProfitOffset: body.takeProfitOffset,
    },
  };
}

function validatePlaceOrderBody(body: PlaceOrderBody): { ok: true; input: PlaceOrderInput } | { ok: false; error: string } {
  if (!body.symbol || typeof body.symbol !== 'string') return { ok: false, error: 'symbol is required (string)' };
  if (typeof body.quantity !== 'number' || body.quantity <= 0) return { ok: false, error: 'quantity must be a positive number' };
  if (!body.side || !VALID_SIDES.includes(body.side as OrderSide)) {
    return { ok: false, error: `side must be one of: ${VALID_SIDES.join(', ')}` };
  }
  if (!body.type || !VALID_TYPES.includes(body.type as OrderType)) {
    return { ok: false, error: `type must be one of: ${VALID_TYPES.join(', ')}` };
  }
  return {
    ok: true,
    input: {
      symbol: body.symbol,
      quantity: body.quantity,
      side: body.side as OrderSide,
      type: body.type as OrderType,
      limitPrice: body.limitPrice,
      stopPrice: body.stopPrice,
    },
  };
}

export function registerBrokerRoutes({
  server,
  placeOrder,
  cancelOrder,
  replaceOrder,
  getBalances,
  getPositions,
  getOrders,
  getHistoricalOrders,
  getQuote,
  placeBracketOrder,
}: {
  server: FastifyInstance;
  placeOrder: PlaceOrder;
  cancelOrder: CancelOrder;
  replaceOrder: ReplaceOrder;
  getBalances: GetBalances;
  getPositions: GetPositions;
  getOrders: GetOrders;
  getHistoricalOrders: GetHistoricalOrders;
  getQuote: GetQuote;
  placeBracketOrder: PlaceBracketOrder;
}) {
  server.post<{ Body: PlaceOrderBody }>('/api/broker/orders', async (request, reply) => {
    const validation = validatePlaceOrderBody(request.body ?? {});
    if (!validation.ok) {
      return reply.status(400).send({ error: validation.error });
    }
    try {
      const result = await placeOrder.execute(validation.input);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(500).send({ error: message });
    }
  });

  server.delete<{ Params: { orderId: string } }>('/api/broker/orders/:orderId', async (request, reply) => {
    const { orderId } = request.params;
    try {
      const result = await cancelOrder.execute({ orderId });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(500).send({ error: message });
    }
  });

  server.put<{ Params: { orderId: string }; Body: PlaceOrderBody }>(
    '/api/broker/orders/:orderId',
    async (request, reply) => {
      const { orderId } = request.params;
      const validation = validatePlaceOrderBody(request.body ?? {});
      if (!validation.ok) {
        return reply.status(400).send({ error: validation.error });
      }
      try {
        const result = await replaceOrder.execute({ orderId, order: validation.input });
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return reply.status(500).send({ error: message });
      }
    },
  );

  server.get<{ Querystring: { symbol?: string } }>('/api/broker/orders', async (request, reply) => {
    try {
      const orders = await getOrders.execute({ symbol: request.query.symbol });
      return { orders };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(500).send({ error: message });
    }
  });

  server.get<{ Querystring: { since?: string } }>('/api/broker/orders/historical', async (request, reply) => {
    const { since } = request.query;
    if (!since) {
      return reply.status(400).send({ error: 'Missing required query param: since (ISO 8601 timestamp)' });
    }
    try {
      const orders = await getHistoricalOrders.execute({ since });
      return { orders };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(500).send({ error: message });
    }
  });

  server.get('/api/broker/balances', async (_request, reply) => {
    try {
      const balance = await getBalances.execute();
      return balance;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(500).send({ error: message });
    }
  });

  server.get('/api/broker/positions', async (_request, reply) => {
    try {
      const positions = await getPositions.execute();
      return { positions };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(500).send({ error: message });
    }
  });

  server.post<{ Body: BracketOrderBody }>('/api/broker/orders/bracket', async (request, reply) => {
    const validation = validateBracketOrderBody(request.body ?? {});
    if (!validation.ok) {
      return reply.status(400).send({ error: validation.error });
    }
    try {
      const result = await placeBracketOrder.execute(validation.input);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(500).send({ error: message });
    }
  });

  server.get<{ Querystring: { symbol?: string } }>('/api/broker/quote', async (request, reply) => {
    const { symbol } = request.query;
    if (!symbol) {
      return reply.status(400).send({ error: 'symbol is required' });
    }
    try {
      const quote = await getQuote.execute({ symbol });
      return quote;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(500).send({ error: message });
    }
  });
}
