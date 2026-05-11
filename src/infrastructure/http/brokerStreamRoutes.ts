import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import type { OrderStreamManager } from '../../application/orderstream/OrderStreamManager.js';
import type { PositionStreamManager } from '../../application/positionstream/PositionStreamManager.js';

const HEARTBEAT_INTERVAL_MS = 15_000;

export interface BrokerStreamRoutesOptions {
  orderStream: OrderStreamManager;
  positionStream: PositionStreamManager;
}

interface Subscription {
  unsubscribe(): void;
}

interface SubscribableStream<E> {
  subscribe(handler: (event: E) => void): Subscription;
  onConnectionChange(handler: (connected: boolean) => void): Subscription;
}

export const brokerStreamRoutes: FastifyPluginAsync<
  BrokerStreamRoutesOptions
> = async (server, opts) => {
  server.get('/api/broker/stream/orders', (req, reply) => {
    reply.hijack();
    pipeManagerToSse(req, reply, opts.orderStream, 'order');
  });

  server.get('/api/broker/stream/positions', (req, reply) => {
    reply.hijack();
    pipeManagerToSse(req, reply, opts.positionStream, 'position');
  });
};

function pipeManagerToSse<E>(
  req: FastifyRequest,
  reply: FastifyReply,
  manager: SubscribableStream<E>,
  eventName: string,
): void {
  setupSseHeaders(reply);
  let nextId = 0;
  const writeEvent = (name: string, data: unknown): void => {
    if (reply.raw.writableEnded) return;
    reply.raw.write(
      `id: ${++nextId}\nevent: ${name}\ndata: ${JSON.stringify(data)}\n\n`,
    );
  };

  // Registrar el listener de cierre ANTES de subscribirse para evitar
  // listeners huérfanos si el cliente cierra durante el replay.
  const cleanups: Array<() => void> = [];
  req.raw.on('close', () => {
    for (const c of cleanups) {
      try {
        c();
      } catch {
        /* noop */
      }
    }
    // Cerrar el response del lado server también — sin esto, app.close()
    // queda colgado esperando que esta conexión termine.
    if (!reply.raw.writableEnded) {
      try {
        reply.raw.end();
      } catch {
        /* noop */
      }
    }
  });

  const sub = manager.subscribe((event) => writeEvent(eventName, event));
  cleanups.push(() => sub.unsubscribe());

  const connSub = manager.onConnectionChange((connected) =>
    writeEvent('connection', { connected }),
  );
  cleanups.push(() => connSub.unsubscribe());

  const heartbeat = setInterval(() => {
    if (reply.raw.writableEnded) return;
    reply.raw.write(': ping\n\n');
  }, HEARTBEAT_INTERVAL_MS);
  cleanups.push(() => clearInterval(heartbeat));
}

function setupSseHeaders(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Disables nginx proxy buffering — sin esto un nginx default puede
    // bufferear todo el stream y matar el real-time.
    'X-Accel-Buffering': 'no',
  });
  // writeHead solo prepara los headers; flushHeaders los envía ya. Sin esto,
  // EventSource del cliente no recibe el response hasta el primer write.
  reply.raw.flushHeaders();
}
