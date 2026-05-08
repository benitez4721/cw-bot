import type { MarketHours } from '../../domain/market/MarketHours.js';
import { logger } from '../../infrastructure/logging/logger.js';

const log = logger.child({ component: 'Heartbeat' });

const STALE_TICK_MS = 3 * 60 * 1000;

// Structural type — BarStreamManager satisfies it.
export interface TickProvider {
  lastSuccessfulTickAt(): number;
}

export interface HeartbeatOptions {
  url: string;
  tickProvider: TickProvider;
  marketHours: MarketHours;
  intervalMs?: number;
}

export class Heartbeat {
  private readonly url: string;
  private readonly tickProvider: TickProvider;
  private readonly marketHours: MarketHours;
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: HeartbeatOptions) {
    this.url = options.url;
    this.tickProvider = options.tickProvider;
    this.marketHours = options.marketHours;
    this.intervalMs = options.intervalMs ?? 60_000;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.ping(), this.intervalMs);
    log.info({ intervalMs: this.intervalMs }, 'started');
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async ping(): Promise<void> {
    const lastTick = this.tickProvider.lastSuccessfulTickAt();
    const open = this.marketHours.isOpen(new Date());

    if (open && lastTick > 0 && Date.now() - lastTick > STALE_TICK_MS) {
      log.warn(
        { lastTick, ageMs: Date.now() - lastTick },
        'last tick stale in market hours — skipping heartbeat',
      );
      return;
    }

    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ts: Date.now(), lastTick, open }),
      });
      if (!res.ok) {
        log.warn({ status: res.status }, 'heartbeat non-2xx');
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'heartbeat post failed',
      );
    }
  }
}
