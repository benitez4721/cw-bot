import type { FastifyInstance } from 'fastify';
import type { EvaluateDecision } from '../../application/decision/EvaluateDecision.js';

interface EvaluateBody {
  symbol?: string;
}

export function registerDecisionRoutes({
  server,
  evaluateDecision,
}: {
  server: FastifyInstance;
  evaluateDecision: EvaluateDecision;
}) {
  server.post<{ Body: EvaluateBody }>('/api/decisions/evaluate', async (request, reply) => {
    const symbol = request.body?.symbol;
    if (!symbol || typeof symbol !== 'string') {
      return reply.status(400).send({ error: 'symbol is required (string)' });
    }
    try {
      const signal = await evaluateDecision.execute({ symbol });
      return signal;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(500).send({ error: message });
    }
  });
}
