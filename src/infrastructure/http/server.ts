import Fastify from 'fastify';
import cors from '@fastify/cors';
import { logger } from '../logging/logger.js';

export async function createServer() {
  const server = Fastify({ loggerInstance: logger });

  await server.register(cors);

  return server;
}
