import type { MetricsPort } from '../../domain/metrics/MetricsPort.js';
import type { ScannerFeedPort } from '../../domain/scanner/ScannerFeedPort.js';
import type { ScannerRow } from '../../domain/scanner/ScannerTypes.js';
import type { WatchlistRepository } from '../../domain/watchlist/WatchlistRepository.js';
import { logger } from '../../infrastructure/logging/logger.js';

const log = logger.child({ component: 'ScannerMonitor' });

export type ScannerMonitorStatus = 'connected' | 'connecting' | 'disconnected';

export interface ScannerMonitorOptions {
  feed: ScannerFeedPort;
  repository: WatchlistRepository;
  metrics: MetricsPort;
  configId: string;
  clock?: () => number;
}

export class ScannerMonitor {
  private readonly feed: ScannerFeedPort;
  private readonly repository: WatchlistRepository;
  private readonly metrics: MetricsPort;
  private readonly configId: string;
  private readonly now: () => number;
  private status: ScannerMonitorStatus = 'disconnected';
  private lastTickAt = 0;

  constructor(options: ScannerMonitorOptions) {
    this.feed = options.feed;
    this.repository = options.repository;
    this.metrics = options.metrics;
    this.configId = options.configId;
    this.now = options.clock ?? Date.now;

    this.feed.onUpdate((configId, rows) => {
      if (configId !== this.configId) return;
      this.handleUpdate(rows).catch((err) => {
        log.error(
          { err: err instanceof Error ? err.message : String(err) },
          'handleUpdate failed',
        );
      });
    });

    this.feed.onConnectionChange((connected) => {
      this.metrics.setScannerConnected(connected);
      this.status = connected ? 'connected' : 'disconnected';
    });
  }

  lastUpdateAt(): number {
    return this.lastTickAt;
  }

  async start(): Promise<void> {
    this.status = 'connecting';
    try {
      await this.feed.connect();
      this.status = 'connected';
      this.metrics.setScannerConnected(true);
      this.feed.subscribe(this.configId);
      log.info({ configId: this.configId }, 'subscribed');
    } catch (err) {
      this.status = 'disconnected';
      this.metrics.setScannerConnected(false);
      throw err;
    }
  }

  stop(): void {
    this.feed.disconnect();
    this.status = 'disconnected';
    this.metrics.setScannerConnected(false);
  }

  getStatus(): ScannerMonitorStatus {
    return this.status;
  }

  getConfigId(): string {
    return this.configId;
  }

  private async handleUpdate(rows: ScannerRow[]): Promise<void> {
    const incoming = new Set<string>();
    const now = this.now();

    for (const row of rows) {
      incoming.add(row.symbol);
      const existing = await this.repository.getBySymbol(row.symbol);

      if (existing) {
        if (existing.status === 'stale') {
          existing.status = 'active';
          await this.repository.put(existing);
        }
      } else {
        await this.repository.put({
          symbol: row.symbol,
          status: 'active',
          createdAt: now,
        });
      }
    }

    const watched = await this.repository.list();
    for (const item of watched) {
      if (item.status !== 'active') continue;
      if (incoming.has(item.symbol)) continue;
      item.status = 'stale';
      await this.repository.put(item);
    }

    this.metrics.setWatchlistSize(watched.length);
    this.lastTickAt = now;
  }
}
