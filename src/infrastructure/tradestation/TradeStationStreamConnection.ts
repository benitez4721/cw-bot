import type { TradeStationClient } from './TradeStationClient.js';
import { logger } from '../logging/logger.js';

const STALL_MS = 35_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const STREAM_ACCEPT = 'application/vnd.tradestation.streams.v3+json';

export interface TradeStationStreamConnectionOptions {
  client: TradeStationClient;
  // Path relativo al apiBase del client; recibe el accountId ya resuelto
  // (para que el caller pueda hacer encodeURIComponent una sola vez).
  pathBuilder: (accountId: string) => string;
  onFrame: (frame: unknown) => void;
  onConnectionChange?: (connected: boolean) => void;
  // Sirve para diferenciar logs de adapters distintos (orders vs positions).
  logName: string;
  // Inyectables para tests
  fetchFn?: typeof fetch;
  schedule?: (cb: () => void, ms: number) => NodeJS.Timeout;
  cancel?: (handle: NodeJS.Timeout) => void;
}

// Long-lived HTTP-streaming connection contra un endpoint /v3/brokerage/stream
// de TradeStation. Maneja parsing por newline (proxies pueden re-chunkear),
// stall timer, refresco de token ante 401 y reconexión con backoff exponencial.
// Subclases/adapters reciben los frames crudos vía onFrame y deciden cómo
// mapearlos al dominio.
export class TradeStationStreamConnection {
  private readonly client: TradeStationClient;
  private readonly pathBuilder: (accountId: string) => string;
  private readonly onFrame: (frame: unknown) => void;
  private readonly onConnectionChange?: (connected: boolean) => void;
  private readonly fetchFn: typeof fetch;
  private readonly schedule: (cb: () => void, ms: number) => NodeJS.Timeout;
  private readonly cancel: (handle: NodeJS.Timeout) => void;
  private readonly log: ReturnType<typeof logger.child>;

  private shouldReconnect = false;
  private abortController: AbortController | null = null;
  private stallTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private connected = false;

  constructor(opts: TradeStationStreamConnectionOptions) {
    this.client = opts.client;
    this.pathBuilder = opts.pathBuilder;
    this.onFrame = opts.onFrame;
    this.onConnectionChange = opts.onConnectionChange;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.schedule = opts.schedule ?? ((cb, ms) => setTimeout(cb, ms));
    this.cancel = opts.cancel ?? ((h) => clearTimeout(h));
    this.log = logger.child({ component: opts.logName });
  }

  start(): void {
    if (this.shouldReconnect) return;
    this.shouldReconnect = true;
    void this.openOnce();
  }

  stop(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      this.cancel(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.clearStallTimer();
    this.notifyConnection(false);
  }

  private async openOnce(retriedAfter401 = false): Promise<void> {
    if (!this.shouldReconnect) return;

    let token: string;
    try {
      token = await this.client.getAccessToken();
    } catch (err) {
      this.log.warn({ err: errMsg(err) }, 'getAccessToken failed');
      this.scheduleReconnect();
      return;
    }

    const url = this.client.apiBase() + this.pathBuilder(this.client.accountId());
    this.abortController = new AbortController();

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: STREAM_ACCEPT,
        },
        signal: this.abortController.signal,
      });
    } catch (err) {
      this.abortController = null;
      if (this.shouldReconnect) {
        this.log.warn({ err: errMsg(err) }, 'connect failed');
        this.scheduleReconnect();
      }
      return;
    }

    if (res.status === 401 && !retriedAfter401) {
      this.log.info('401 — invalidating token and retrying once');
      this.client.invalidateToken();
      this.abortController = null;
      await this.openOnce(true);
      return;
    }

    if (!res.ok || !res.body) {
      this.log.warn({ status: res.status }, 'http error opening stream');
      this.abortController = null;
      this.scheduleReconnect();
      return;
    }

    this.notifyConnection(true);
    try {
      await this.consume(res.body);
    } catch (err) {
      if (this.shouldReconnect) {
        this.log.warn({ err: errMsg(err) }, 'stream consume error');
      }
    } finally {
      this.abortController = null;
      this.clearStallTimer();
      this.notifyConnection(false);
    }

    if (this.shouldReconnect) this.scheduleReconnect();
  }

  private async consume(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    this.resetStallTimer();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        this.resetStallTimer();
        // Primer chunk recibido = conexión sana → reset del backoff.
        if (this.consecutiveFailures > 0) this.consecutiveFailures = 0;
        buffer += decoder.decode(value, { stream: true });
        // TS delimita frames con CRLF (verificado empíricamente sobre SIM).
        // Hacemos split por '\n' y trim para tolerar también '\n' a secas.
        let nl = buffer.indexOf('\n');
        while (nl !== -1) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf('\n');
          if (!line) continue;
          let frame: unknown;
          try {
            frame = JSON.parse(line);
          } catch (err) {
            this.log.warn(
              { err: errMsg(err), line: line.slice(0, 120) },
              'invalid json frame',
            );
            continue;
          }
          try {
            this.onFrame(frame);
          } catch (err) {
            this.log.warn({ err: errMsg(err) }, 'onFrame handler threw');
          }
        }
      }
    } finally {
      this.clearStallTimer();
    }
  }

  private resetStallTimer(): void {
    if (this.stallTimer) this.cancel(this.stallTimer);
    this.stallTimer = this.schedule(() => {
      this.log.warn('stream stalled — aborting');
      this.abortController?.abort();
    }, STALL_MS);
  }

  private clearStallTimer(): void {
    if (this.stallTimer) {
      this.cancel(this.stallTimer);
      this.stallTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    if (this.reconnectTimer) return;
    const delay = Math.min(
      BACKOFF_BASE_MS * 2 ** Math.min(this.consecutiveFailures, 5),
      BACKOFF_MAX_MS,
    );
    this.consecutiveFailures += 1;
    this.log.info(
      { delayMs: delay, attempt: this.consecutiveFailures },
      'scheduling reconnect',
    );
    this.reconnectTimer = this.schedule(() => {
      this.reconnectTimer = null;
      void this.openOnce();
    }, delay);
  }

  private notifyConnection(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    try {
      this.onConnectionChange?.(connected);
    } catch (err) {
      this.log.warn(
        { err: errMsg(err) },
        'onConnectionChange handler threw',
      );
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
