import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type {
  OrderEvent,
  PositionEvent,
} from '../../domain/broker/BrokerStreamTypes.js';

const HEARTBEAT_INTERVAL_MS = 15_000;

interface Subscription {
  unsubscribe(): void;
}

// Fachada estructural que cumple un Manager individual (1 stream = 1 account).
interface SubscribableStream<E> {
  // `subscribe` puede ser async (OrderStream refresca contextos en Redis
  // antes del replay) o sync (PositionStream). El caller siempre hace
  // `await` para uniformar el manejo.
  subscribe(handler: (event: E) => void): Promise<Subscription> | Subscription;
  onConnectionChange(handler: (connected: boolean) => void): Subscription;
}

// Multi-account: cada accountId tiene su propio Manager (un websocket por
// cuenta). La ruta SSE hace fan-out sobre los N managers para que el cliente
// vea un único stream "todas las orders / todas las positions". El consumer
// distingue cada evento por `event.accountId`.
export interface BrokerStreamRoutesOptions {
  orderStreams: ReadonlyMap<string, SubscribableStream<OrderEvent>>;
  positionStreams: ReadonlyMap<string, SubscribableStream<PositionEvent>>;
}

export const brokerStreamRoutes: FastifyPluginAsync<
  BrokerStreamRoutesOptions
> = async (server, opts) => {
  server.get('/api/broker/stream/orders', async (req, reply) => {
    reply.hijack();
    await pipeStreamsToSse(req, reply, opts.orderStreams, 'order');
  });

  server.get('/api/broker/stream/positions', async (req, reply) => {
    reply.hijack();
    await pipeStreamsToSse(req, reply, opts.positionStreams, 'position');
  });
};

async function pipeStreamsToSse<E>(
  req: FastifyRequest,
  reply: FastifyReply,
  streams: ReadonlyMap<string, SubscribableStream<E>>,
  eventName: string,
): Promise<void> {
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
  let closed = false;
  req.raw.on('close', () => {
    closed = true;
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

  // Fan-out: subscribe a cada manager en paralelo. Si el cliente cerró
  // mientras esperábamos los subscribe async (el OrderStream consulta Redis
  // antes del replay), unsubscribe inmediatamente — el cleanup todavía no
  // tenía las subs registradas.
  const managers = Array.from(streams.values());
  const subs = await Promise.all(
    managers.map((m) =>
      m.subscribe((event: E) => writeEvent(eventName, event)),
    ),
  );
  if (closed) {
    for (const s of subs) s.unsubscribe();
    return;
  }
  cleanups.push(() => {
    for (const s of subs) s.unsubscribe();
  });

  const connSubs = managers.map((m) =>
    m.onConnectionChange((connected) =>
      writeEvent('connection', { connected }),
    ),
  );
  cleanups.push(() => {
    for (const s of connSubs) s.unsubscribe();
  });

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
    // reply.hijack() bypasea los hooks de @fastify/cors, asi que el header
    // CORS hay que escribirlo a mano. '*' coincide con el default del
    // plugin (cors() sin opciones).
    'Access-Control-Allow-Origin': '*',
  });
  // writeHead solo prepara los headers; flushHeaders los envía ya. Sin esto,
  // EventSource del cliente no recibe el response hasta el primer write.
  reply.raw.flushHeaders();
}
