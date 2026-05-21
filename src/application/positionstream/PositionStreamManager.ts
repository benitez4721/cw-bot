import { EventEmitter } from 'node:events';
import type { Position } from '../../domain/broker/BrokerTypes.js';
import type {
  PositionEvent,
  PositionStreamHandler,
} from '../../domain/broker/BrokerStreamTypes.js';
import type { PositionStreamPort } from '../../domain/broker/PositionStreamPort.js';
import { logger } from '../../infrastructure/logging/logger.js';

const log = logger.child({ component: 'PositionStreamManager' });

export interface StreamSubscription {
  unsubscribe(): void;
}

export interface PositionStreamManagerOptions {
  stream: PositionStreamPort;
  now?: () => string;
}

// Snapshot in-memory keyed by symbol + fan-out. Una posición con
// quantity === 0 representa cierre; el manager la elimina del snapshot
// (no la propaga al replay de futuros subscribers).
export class PositionStreamManager {
  private readonly stream: PositionStreamPort;
  private readonly now: () => string;
  private readonly positions = new Map<string, Position>();
  private readonly emitter = new EventEmitter();
  private connected = false;

  constructor(options: PositionStreamManagerOptions) {
    this.stream = options.stream;
    this.now = options.now ?? (() => new Date().toISOString());
    this.stream.onPosition((event) => this.onUpstreamPosition(event));
    this.stream.onConnectionChange((connected) => {
      this.connected = connected;
      this.emitter.emit('connection', connected);
    });
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

  getSnapshot(): Position[] {
    return Array.from(this.positions.values());
  }

  subscribe(handler: PositionStreamHandler): StreamSubscription {
    const observedAt = this.now();
    for (const position of this.positions.values()) {
      try {
        handler({ position, observedAt, origin: 'priorState' });
      } catch (err) {
        log.warn({ err: errMsg(err) }, 'subscriber threw on snapshot replay');
      }
    }
    this.emitter.on('position', handler);
    return {
      unsubscribe: () => {
        this.emitter.off('position', handler);
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

  private onUpstreamPosition(event: PositionEvent): void {
    if (event.position.quantity === 0) {
      this.positions.delete(event.position.symbol);
    } else {
      this.positions.set(event.position.symbol, event.position);
    }
    this.emitter.emit('position', event);
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
