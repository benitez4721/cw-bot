import WebSocket from 'ws';
import type { ScannerFeedPort } from '../../domain/scanner/ScannerFeedPort.js';
import type {
  ScannerColumn,
  ScannerRow,
} from '../../domain/scanner/ScannerTypes.js';

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
        console.log('[ChartsWatcher] Connected');
        for (const configId of Object.keys(this.subscribedConfigs)) {
          this.sendSubscribe(configId);
        }
        resolve();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('close', () => {
        console.log('[ChartsWatcher] Disconnected');
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      });

      this.ws.on('error', (err) => {
        console.error('[ChartsWatcher] Error:', err.message);
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

  unsubscribe(configId: string): void {
    delete this.subscribedConfigs[configId];
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          '@type': 'Toplist',
          config_id: configId,
          action: 'unsubscribe',
        }),
      );
    }
  }

  onUpdate(callback: (configId: string, rows: ScannerRow[]) => void): void {
    this.updateCallbacks.push(callback);
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
      console.warn('[ChartsWatcher] Failed to parse message:', raw);
      return;
    }

    switch (msg['@type']) {
      case 'KeepAlive':
        break;

      case 'ToplistConfirm':
        console.log(`[ChartsWatcher] Subscription confirmed: ${msg.config_id}`);
        break;

      case 'ToplistUpdate':
        this.handleUpdate(msg);
        break;

      case 'Error':
        // TODO: distinguish fatal (invalid api_key) from per-config errors (unknown config_id).
        console.error('[ChartsWatcher] Server error:', msg.message);
        break;

      default:
        console.warn(
          '[ChartsWatcher] Unknown message type:',
          (msg as { '@type': string })['@type'],
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
    console.log('[ChartsWatcher] Reconnecting in 5s...');
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch (err) {
        console.error('[ChartsWatcher] Reconnection failed:', err);
        this.scheduleReconnect();
      }
    }, 5000);
  }
}
