import WebSocket from 'ws';
import type {
  BarHandler,
  ConnectionHandler,
  MarketFeedPort,
} from '../../domain/marketdata/MarketFeedPort.js';
import type { Bar } from '../../domain/marketdata/MarketDataTypes.js';
import { logger } from '../logging/logger.js';

const log = logger.child({ component: 'PolygonAdapter' });

export interface PolygonAdapterConfig {
  apiKey: string;
  wsUrl: string;
  authTimeoutMs?: number;
  reconnectDelayMs?: number;
}

interface PolygonStatusEvent {
  ev: 'status';
  status: string;
  message?: string;
}

interface PolygonAggEvent {
  ev: 'AM';
  sym: string;
  v: number;
  o: number;
  c: number;
  h: number;
  l: number;
  s: number;
  e: number;
}

type PolygonEvent = PolygonStatusEvent | PolygonAggEvent;

const DEFAULT_AUTH_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_DELAY_MS = 5_000;

// Realtime feed via Polygon's stocks WS. Subscribes to `AM.{symbol}` (1-minute
// aggregates published at minute close). Historical bootstrap is NOT here —
// see HistoricalBarsPort (TwelveDataAdapter).
export class PolygonAdapter implements MarketFeedPort {
  private readonly config: PolygonAdapterConfig;
  private ws: WebSocket | null = null;
  private subscribed: Record<string, true> = {};
  private barHandlers: BarHandler[] = [];
  private connectionHandlers: ConnectionHandler[] = [];
  private shouldReconnect = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private authResolve: (() => void) | null = null;
  private authReject: ((err: Error) => void) | null = null;
  private authTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: PolygonAdapterConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    this.shouldReconnect = true;
    return this.openConnection();
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearAuthState();
    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.close();
      this.ws = null;
    }
  }

  subscribe(symbol: string): void {
    this.subscribed[symbol] = true;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe(symbol);
    }
  }

  unsubscribe(symbol: string): void {
    delete this.subscribed[symbol];
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({ action: 'unsubscribe', params: `AM.${symbol}` }),
      );
    }
  }

  onBar(handler: BarHandler): void {
    this.barHandlers.push(handler);
  }

  onConnectionChange(handler: ConnectionHandler): void {
    this.connectionHandlers.push(handler);
  }

  private openConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.config.wsUrl);
      this.ws = ws;
      this.authResolve = resolve;
      this.authReject = reject;
      this.authTimer = setTimeout(() => {
        this.failAuth(new Error('Polygon WS: auth timeout'));
      }, this.config.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS);

      ws.on('open', () => {
        log.info('ws open — sending auth');
        ws.send(
          JSON.stringify({ action: 'auth', params: this.config.apiKey }),
        );
      });

      ws.on('message', (data) => {
        this.handleMessage(data.toString());
      });

      ws.on('close', () => {
        log.info('ws closed');
        this.notifyConnection(false);
        this.failAuth(new Error('Polygon WS: closed before auth'));
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });

      ws.on('error', (err) => {
        log.warn({ err: err.message }, 'ws error');
        if (ws.readyState !== WebSocket.OPEN) {
          this.failAuth(err);
        }
      });
    });
  }

  private handleMessage(raw: string): void {
    let events: PolygonEvent[];
    try {
      const parsed = JSON.parse(raw);
      events = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      log.warn({ raw: raw.slice(0, 200) }, 'failed to parse message');
      return;
    }

    for (const event of events) {
      if (event.ev === 'status') {
        this.handleStatus(event);
      } else if (event.ev === 'AM') {
        this.handleAggregate(event);
      } else {
        log.debug({ ev: (event as { ev: string }).ev }, 'unhandled event');
      }
    }
  }

  private handleStatus(event: PolygonStatusEvent): void {
    switch (event.status) {
      case 'connected':
        break;
      case 'auth_success':
        log.info('authenticated');
        this.completeAuth();
        this.notifyConnection(true);
        for (const symbol of Object.keys(this.subscribed)) {
          this.sendSubscribe(symbol);
        }
        break;
      case 'auth_failed':
        log.error({ message: event.message }, 'auth failed');
        this.failAuth(new Error(`Polygon WS: auth failed: ${event.message}`));
        this.shouldReconnect = false;
        this.ws?.close();
        break;
      case 'success':
        log.debug({ message: event.message }, 'subscription ack');
        break;
      default:
        log.warn({ status: event.status, message: event.message }, 'status');
    }
  }

  private handleAggregate(event: PolygonAggEvent): void {
    const bar = wsAggToBar(event);
    for (const handler of this.barHandlers) {
      try {
        handler(event.sym, bar);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'bar handler failed',
        );
      }
    }
  }

  private completeAuth(): void {
    const resolve = this.authResolve;
    this.clearAuthState();
    resolve?.();
  }

  private failAuth(err: Error): void {
    const reject = this.authReject;
    this.clearAuthState();
    reject?.(err);
  }

  private clearAuthState(): void {
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
    this.authResolve = null;
    this.authReject = null;
  }

  private sendSubscribe(symbol: string): void {
    this.ws?.send(
      JSON.stringify({ action: 'subscribe', params: `AM.${symbol}` }),
    );
  }

  private notifyConnection(connected: boolean): void {
    for (const handler of this.connectionHandlers) {
      try {
        handler(connected);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'connection handler failed',
        );
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.shouldReconnect) return;
    const delay = this.config.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    log.info({ delayMs: delay }, 'reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openConnection().catch((err) => {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          'reconnect failed',
        );
        this.scheduleReconnect();
      });
    }, delay);
  }
}

function wsAggToBar(e: PolygonAggEvent): Bar {
  return {
    timestamp: new Date(e.s).toISOString(),
    open: e.o,
    high: e.h,
    low: e.l,
    close: e.c,
    volume: e.v,
  };
}
