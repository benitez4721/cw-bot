import WebSocket from 'ws';
import type { ScannerFeedPort } from '../../domain/scanner/ScannerFeedPort.js';
import type {
  ScannerColumn,
  ScannerRow,
} from '../../domain/scanner/ScannerTypes.js';
import { logger } from '../logging/logger.js';

const log = logger.child({ component: 'ChartsWatcherAdapter' });

export interface ChartsWatcherConfig {
  wsUrl: string;
  userId: string;
  apiKey: string;
}

interface CWToplistConfirm {
  '@type': 'ToplistConfirm';
  success: boolean;
  config_id: string;
}

interface CWToplistUpdate {
  '@type': 'ToplistUpdate';
  config_id: string;
  rows: {
    symbol: string;
    columns: {
      key: string;
      value: string;
    }[];
  }[];
}

interface CWKeepAlive {
  '@type': 'KeepAlive';
}

interface CWError {
  '@type': 'Error';
  message: string;
}

type CWMessage = CWToplistConfirm | CWToplistUpdate | CWKeepAlive | CWError;

export class ChartsWatcherAdapter implements ScannerFeedPort {
  private ws: WebSocket | null = null;
  private readonly config: ChartsWatcherConfig;
  private updateCallbacks: ((configId: string, rows: ScannerRow[]) => void)[] =
    [];
  private connectionCallbacks: ((connected: boolean) => void)[] = [];
  private subscribedConfigs: Record<string, true> = {};
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;

  constructor(config: ChartsWatcherConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${this.config.wsUrl}?user_id=${this.config.userId}&api_key=${this.config.apiKey}`;
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        log.info('connected');
        this.notifyConnection(true);
        for (const configId of Object.keys(this.subscribedConfigs)) {
          this.sendSubscribe(configId);
        }
        resolve();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('close', () => {
        log.info('disconnected');
        this.notifyConnection(false);
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        log.error({ err: err.message }, 'ws error');
        if (this.ws?.readyState !== WebSocket.OPEN) {
          reject(err);
        }
      });
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  subscribe(configId: string): void {
    this.subscribedConfigs[configId] = true;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe(configId);
    }
  }

  onUpdate(callback: (configId: string, rows: ScannerRow[]) => void): void {
    this.updateCallbacks.push(callback);
  }

  onConnectionChange(callback: (connected: boolean) => void): void {
    this.connectionCallbacks.push(callback);
  }

  private notifyConnection(connected: boolean): void {
    for (const cb of this.connectionCallbacks) {
      try {
        cb(connected);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'connection callback failed',
        );
      }
    }
  }

  private sendSubscribe(configId: string): void {
    this.ws?.send(
      JSON.stringify({
        '@type': 'Toplist',
        config_id: configId,
        action: 'subscribe',
      }),
    );
  }

  private handleMessage(raw: string): void {
    let msg: CWMessage;
    try {
      msg = JSON.parse(raw) as CWMessage;
    } catch {
      log.warn({ raw }, 'failed to parse message');
      return;
    }

    switch (msg['@type']) {
      case 'KeepAlive':
        break;

      case 'ToplistConfirm':
        log.info({ configId: msg.config_id }, 'subscription confirmed');
        break;

      case 'ToplistUpdate':
        this.handleUpdate(msg);
        break;

      case 'Error':
        // TODO: distinguish fatal (invalid api_key) from per-config errors (unknown config_id).
        log.error({ message: msg.message }, 'server error');
        break;

      default:
        log.warn(
          { type: (msg as { '@type': string })['@type'] },
          'unknown message type',
        );
    }
  }

  private handleUpdate(msg: CWToplistUpdate): void {
    const rows: ScannerRow[] = msg.rows.map((r) => ({
      symbol: r.symbol,
      columns: r.columns.map(
        (c): ScannerColumn => ({ key: c.key, value: c.value }),
      ),
    }));

    for (const cb of this.updateCallbacks) {
      cb(msg.config_id, rows);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    log.info('reconnecting in 5s');
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch (err) {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          'reconnection failed',
        );
        this.scheduleReconnect();
      }
    }, 5000);
  }
}
