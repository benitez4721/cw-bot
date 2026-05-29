import { EventEmitter } from 'node:events';
import type { OrderWithContext } from '../../domain/broker/BrokerTypes.js';
import type {
  OrderEvent,
  OrderStreamHandler,
} from '../../domain/broker/BrokerStreamTypes.js';
import type { OrderStreamPort } from '../../domain/broker/OrderStreamPort.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../domain/trade/TradeTypes.js';
import { logger } from '../../infrastructure/logging/logger.js';
import type { RecordOrderFill } from '../trade/RecordOrderFill.js';

const log = logger.child({ component: 'OrderStreamManager' });

export interface StreamSubscription {
  unsubscribe(): void;
}

export interface OrderStreamManagerOptions {
  stream: OrderStreamPort;
  // Account contra el que está conectado el `stream`. Cada manager es 1:1
  // con un account; el replay sintético del snapshot lo usa para enriquecer
  // los eventos del subscribe.
  accountId: string;
  tradeRepo: TradeContextRepository;
  recordOrderFill: RecordOrderFill;
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
  private readonly accountId: string;
  private readonly tradeRepo: TradeContextRepository;
  private readonly recordOrderFill: RecordOrderFill;
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
    this.accountId = options.accountId;
    this.tradeRepo = options.tradeRepo;
    this.recordOrderFill = options.recordOrderFill;
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

  // Replay del snapshot actual con origin='priorState' + suscripción a updates
  // futuros. Antes del replay, re-consulta el TradeContextRepository para los
  // orderIds cacheados que aún no tienen `context`: cubre la race entre el
  // WS update inicial (que llega antes de que RecordTradeContext escriba en
  // Redis) y el lookup en `process()`, que de otra forma deja el snapshot
  // congelado sin contexto.
  async subscribe(handler: OrderStreamHandler): Promise<StreamSubscription> {
    await this.refreshMissingContexts();
    const observedAt = this.now();
    for (const order of this.orders.values()) {
      try {
        handler({
          order,
          accountId: this.accountId,
          observedAt,
          origin: 'priorState',
        });
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

  private async refreshMissingContexts(): Promise<void> {
    const missingIds: string[] = [];
    for (const [id, order] of this.orders) {
      if (!order.context) missingIds.push(id);
    }
    if (missingIds.length === 0) return;
    let contexts: Awaited<ReturnType<TradeContextRepository['getByOrderIds']>>;
    try {
      contexts = await this.tradeRepo.getByOrderIds(missingIds);
    } catch (err) {
      log.warn(
        { err: errMsg(err) },
        'failed to refresh snapshot contexts on subscribe',
      );
      return;
    }
    for (const [id, ctx] of contexts) {
      const order = this.orders.get(id);
      if (order && !order.context) {
        this.orders.set(id, { ...order, context: ctx });
      }
    }
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
    let context: TradeContext | undefined;
    try {
      context = await this.tradeRepo.getByOrderId(event.order.id);
      if (context) enrichedOrder = { ...event.order, context };
    } catch (err) {
      log.warn(
        { err: errMsg(err), orderId: event.order.id },
        'trade context lookup failed; emitting without context',
      );
    }
    // Persistir el fill (entry/stop/tp/forced) en el TradeContext para que
    // el PnL real quede reconstruible sin consultar al broker. Idempotente:
    // RecordOrderFill skipea writes si los valores ya coinciden.
    // Race conocida WS-vs-Redis: el fill puede llegar antes del put(ctx).
    // Cuando no hay context, no hacemos nada — ReconcileEntryFill corre en
    // OnScannerAlert/BarStreamManager justo despues del put y recupera el
    // fill via getOrders + recordOrderFill (idempotente).
    if (context) {
      try {
        await this.recordOrderFill.execute({
          ctx: context,
          order: event.order,
        });
      } catch (err) {
        log.warn(
          { err: errMsg(err), orderId: event.order.id },
          'recordOrderFill failed',
        );
      }
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
