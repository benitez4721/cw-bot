import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface AuthMiddlewareOptions {
  apiToken: string | undefined;
  protectedPrefix: string;
}

interface HookableServer {
  addHook(name: 'onRequest', fn: HookFn): void;
}

type HookFn = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<unknown> | unknown;

export function registerAuthMiddleware(
  server: HookableServer,
  options: AuthMiddlewareOptions,
): void {
  const { apiToken, protectedPrefix } = options;

  server.addHook('onRequest', async (request, reply) => {
    if (!isProtected(request.url, protectedPrefix)) return;

    if (!apiToken) {
      return reply
        .code(503)
        .send({ error: 'api token not configured (fail-closed)' });
    }

    const provided = extractBearer(request);
    if (!provided || !constantTimeEqual(provided, apiToken)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });
}

function isProtected(url: string, prefix: string): boolean {
  const path = url.split('?')[0];
  return path.startsWith(prefix);
}

function extractBearer(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return null;
  return token;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
