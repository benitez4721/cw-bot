import { EventEmitter } from 'node:events';
import type { OrderWithContext } from '../../domain/broker/BrokerTypes.js';
import type {
  OrderEvent,
  OrderStreamHandler,
} from '../../domain/broker/BrokerStreamTypes.js';
import type { OrderStreamPort } from '../../domain/broker/OrderStreamPort.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import { logger } from '../../infrastructure/logging/logger.js';

const log = logger.child({ component: 'OrderStreamManager' });

export interface StreamSubscription {
  unsubscribe(): void;
}

export interface OrderStreamManagerOptions {
  stream: OrderStreamPort;
  tradeRepo: TradeContextRepository;
  // Inyectable para tests; default: () => new Date().toISOString().
  now?: () => string;
}

// Mantiene un snapshot in-memory keyed by orderId con el último estado
// conocido y hace fan-out a múltiples consumers (lógica interna del bot,
// rutas SSE) usando un EventEmitter. En cada (re)conexión, el adapter
// reenvía el snapshot completo y el manager reconcilia overwriteando por id.
// Cada evento se enriquece con el TradeContext correspondiente (cuando
// existe en el repo) antes de emitirse, para que el dashboard reciba el
// snapshot de indicadores junto con la orden.
export class OrderStreamManager {
  private readonly stream: OrderStreamPort;
  private readonly tradeRepo: TradeContextRepository;
  private readonly now: () => string;
  private readonly orders = new Map<string, OrderWithContext>();
  private readonly emitter = new EventEmitter();
  private connected = false;
  // Serializa el procesamiento de eventos para preservar el orden de llegada
  // pese al lookup async del contexto en Redis. Order events no son de alta
  // frecuencia, así que un único tail global es suficiente.
  private tail: Promise<void> = Promise.resolve();

  constructor(options: OrderStreamManagerOptions) {
    this.stream = options.stream;
    this.tradeRepo = options.tradeRepo;
    this.now = options.now ?? (() => new Date().toISOString());
    this.stream.onOrder((event) => this.enqueue(event));
    this.stream.onConnectionChange((connected) => {
      this.connected = connected;
      this.emitter.emit('connection', connected);
    });
    // EventEmitter por default warn-ea al pasar 10 listeners; el SSE puede
    // tener más clientes, así que lo subimos.
    this.emitter.setMaxListeners(0);
  }

  async start(): Promise<void> {
    await this.stream.connect();
  }

  stop(): void {
    this.stream.disconnect();
  }

  isConnected(): boolean {
    return this.connected;
  }

  getSnapshot(): OrderWithContext[] {
    return Array.from(this.orders.values());
  }

  // Replay sincrónico del snapshot actual con origin='priorState' + suscripción
  // a updates futuros. El handler ve un único stream coherente (priorState
  // primero, liveUpdate después).
  subscribe(handler: OrderStreamHandler): StreamSubscription {
    const observedAt = this.now();
    for (const order of this.orders.values()) {
      try {
        handler({ order, observedAt, origin: 'priorState' });
      } catch (err) {
        log.warn({ err: errMsg(err) }, 'subscriber threw on snapshot replay');
      }
    }
    this.emitter.on('order', handler);
    return {
      unsubscribe: () => {
        this.emitter.off('order', handler);
      },
    };
  }

  onConnectionChange(
    handler: (connected: boolean) => void,
  ): StreamSubscription {
    this.emitter.on('connection', handler);
    return {
      unsubscribe: () => {
        this.emitter.off('connection', handler);
      },
    };
  }

  // Resuelve cuando la cola interna terminó de procesar todo lo encolado
  // hasta el momento. Usado por tests para sincronizar con el lookup async.
  idle(): Promise<void> {
    return this.tail;
  }

  private enqueue(event: OrderEvent): void {
    this.tail = this.tail
      .then(() => this.process(event))
      .catch(() => {
        /* process() ya logea sus errores; el .catch evita romper la cadena */
      });
  }

  private async process(event: OrderEvent): Promise<void> {
    let enrichedOrder: OrderWithContext = event.order;
    try {
      const context = await this.tradeRepo.getByOrderId(event.order.id);
      if (context) enrichedOrder = { ...event.order, context };
    } catch (err) {
      log.warn(
        { err: errMsg(err), orderId: event.order.id },
        'trade context lookup failed; emitting without context',
      );
    }
    // Reconciliación: priorState reemplaza, liveUpdate también reemplaza.
    // No hay estado terminal que borre — el dashboard quiere ver historia.
    this.orders.set(event.order.id, enrichedOrder);
    this.emitter.emit('order', { ...event, order: enrichedOrder });
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
