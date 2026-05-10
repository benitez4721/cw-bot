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
  if (header) {
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && token) return token;
  }
  // SSE fallback: EventSource del browser no soporta headers custom.
  // Aceptamos ?token=... ÚNICAMENTE en /api/broker/stream/*; el resto de
  // /api/* sigue exigiendo Authorization header.
  const path = request.url.split('?')[0];
  if (path.startsWith('/api/broker/stream/')) {
    const parsed = new URL(request.url, 'http://placeholder');
    const token = parsed.searchParams.get('token');
    if (token) return token;
  }
  return null;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
