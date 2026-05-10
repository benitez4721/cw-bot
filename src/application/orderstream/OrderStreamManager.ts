import { EventEmitter } from 'node:events';
import type { Order } from '../../domain/broker/BrokerTypes.js';
import type {
  OrderEvent,
  OrderStreamHandler,
} from '../../domain/broker/BrokerStreamTypes.js';
import type { OrderStreamPort } from '../../domain/broker/OrderStreamPort.js';
import { logger } from '../../infrastructure/logging/logger.js';

const log = logger.child({ component: 'OrderStreamManager' });

export interface StreamSubscription {
  unsubscribe(): void;
}

export interface OrderStreamManagerOptions {
  stream: OrderStreamPort;
  // Inyectable para tests; default: () => new Date().toISOString().
  now?: () => string;
}

// Mantiene un snapshot in-memory keyed by orderId con el último estado
// conocido y hace fan-out a múltiples consumers (lógica interna del bot,
// rutas SSE) usando un EventEmitter. En cada (re)conexión, el adapter
// reenvía el snapshot completo y el manager reconcilia overwriteando por id.
export class OrderStreamManager {
  private readonly stream: OrderStreamPort;
  private readonly now: () => string;
  private readonly orders = new Map<string, Order>();
  private readonly emitter = new EventEmitter();
  private connected = false;

  constructor(options: OrderStreamManagerOptions) {
    this.stream = options.stream;
    this.now = options.now ?? (() => new Date().toISOString());
    this.stream.onOrder((event) => this.onUpstreamOrder(event));
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

  getSnapshot(): Order[] {
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

  private onUpstreamOrder(event: OrderEvent): void {
    // Reconciliación: priorState reemplaza, liveUpdate también reemplaza.
    // No hay estado terminal que borre — el dashboard quiere ver historia.
    this.orders.set(event.order.id, event.order);
    this.emitter.emit('order', event);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
