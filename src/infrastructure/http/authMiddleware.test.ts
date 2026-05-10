import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerAuthMiddleware } from './authMiddleware.js';

function buildServer(apiToken: string | undefined): FastifyInstance {
  const f = Fastify();
  registerAuthMiddleware(f, { apiToken, protectedPrefix: '/api' });
  f.get('/api/foo', async () => ({ ok: true }));
  f.get('/api/broker/stream/orders', async () => ({ ok: true }));
  f.get('/public/health', async () => ({ ok: true }));
  return f;
}

describe('authMiddleware', () => {
  it('lets unprotected paths through without a token', async () => {
    const f = buildServer('secret');
    const res = await f.inject({ method: 'GET', url: '/public/health' });
    expect(res.statusCode).toBe(200);
  });

  it('rejects protected paths without any token', async () => {
    const f = buildServer('secret');
    const res = await f.inject({ method: 'GET', url: '/api/foo' });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a valid Authorization: Bearer header', async () => {
    const f = buildServer('secret');
    const res = await f.inject({
      method: 'GET',
      url: '/api/foo',
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a wrong Authorization: Bearer header', async () => {
    const f = buildServer('secret');
    const res = await f.inject({
      method: 'GET',
      url: '/api/foo',
      headers: { authorization: 'Bearer not-the-token' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts ?token= on /api/broker/stream/* (SSE fallback)', async () => {
    const f = buildServer('secret');
    const res = await f.inject({
      method: 'GET',
      url: '/api/broker/stream/orders?token=secret',
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects ?token= on a non-stream protected path', async () => {
    const f = buildServer('secret');
    const res = await f.inject({
      method: 'GET',
      url: '/api/foo?token=secret',
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects an invalid ?token= on a stream path', async () => {
    const f = buildServer('secret');
    const res = await f.inject({
      method: 'GET',
      url: '/api/broker/stream/orders?token=wrong',
    });
    expect(res.statusCode).toBe(401);
  });

  it('fail-closed with 503 when apiToken is not configured', async () => {
    const f = buildServer(undefined);
    const res = await f.inject({
      method: 'GET',
      url: '/api/broker/stream/orders?token=anything',
    });
    expect(res.statusCode).toBe(503);
  });

  it('prefers Authorization header over ?token= when both are present', async () => {
    const f = buildServer('secret');
    const res = await f.inject({
      method: 'GET',
      url: '/api/broker/stream/orders?token=wrong',
      headers: { authorization: 'Bearer secret' },
    });
    expect(res.statusCode).toBe(200);
  });
});
