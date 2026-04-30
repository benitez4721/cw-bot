import Fastify from 'fastify';
import cors from '@fastify/cors';

export async function createServer() {
  const server = Fastify({ logger: false });

  await server.register(cors);

  return server;
}
