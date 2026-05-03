import type { FastifyPluginAsync } from 'fastify';
import type { Registry } from 'prom-client';

interface MetricsRoutesOptions {
  registry: Registry;
}

export const metricsRoutes: FastifyPluginAsync<MetricsRoutesOptions> = async (
  server,
  opts,
) => {
  server.get('/metrics', async (_req, reply) => {
    reply.header('Content-Type', opts.registry.contentType);
    return opts.registry.metrics();
  });
};
