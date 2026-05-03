import type { ScannerFeedPort } from '../../domain/scanner/ScannerFeedPort.js';
import type { ScannerRow } from '../../domain/scanner/ScannerTypes.js';
import type { WatchlistRepository } from '../../domain/watchlist/WatchlistRepository.js';

export type ScannerMonitorStatus =
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'disabled';

export interface ScannerMonitorOptions {
  feed: ScannerFeedPort;
  repository: WatchlistRepository;
  configId: string;
  enabled?: boolean;
  clock?: () => number;
}

export class ScannerMonitor {
  private readonly feed: ScannerFeedPort;
  private readonly repository: WatchlistRepository;
  private readonly configId: string;
  private readonly enabled: boolean;
  private readonly now: () => number;
  private status: ScannerMonitorStatus;

  constructor(options: ScannerMonitorOptions) {
    this.feed = options.feed;
    this.repository = options.repository;
    this.configId = options.configId;
    this.enabled = options.enabled ?? true;
    this.now = options.clock ?? Date.now;
    this.status = this.enabled ? 'disconnected' : 'disabled';

    this.feed.onUpdate((_configId, rows) => this.handleUpdate(rows));
  }

  async start(): Promise<void> {
    if (!this.enabled) {
      console.log('[ScannerMonitor] Disabled by config — skipping connect.');
      return;
    }
    this.status = 'connecting';
    try {
      await this.feed.connect();
      this.status = 'connected';
      this.feed.subscribe(this.configId);
      console.log(`[ScannerMonitor] Subscribed to ${this.configId}.`);
    } catch (err) {
      this.status = 'disconnected';
      throw err;
    }
  }

  stop(): void {
    if (!this.enabled) return;
    this.feed.disconnect();
    this.status = 'disconnected';
  }

  getStatus(): ScannerMonitorStatus {
    return this.status;
  }

  getConfigId(): string {
    return this.configId;
  }

  private handleUpdate(rows: ScannerRow[]): void {
    const incoming = new Set<string>();
    const now = this.now();

    for (const row of rows) {
      incoming.add(row.symbol);
      const existing = this.repository.getBySymbol(row.symbol);

      if (existing) {
        if (existing.status === 'stale') {
          existing.status = 'active';
          this.repository.update(existing);
        }
      } else {
        this.repository.insert({
          symbol: row.symbol,
          status: 'active',
          createdAt: now,
        });
      }
    }

    for (const watched of this.repository.list()) {
      if (watched.status !== 'active') continue;
      if (incoming.has(watched.symbol)) continue;
      watched.status = 'stale';
      this.repository.update(watched);
    }
  }
}
