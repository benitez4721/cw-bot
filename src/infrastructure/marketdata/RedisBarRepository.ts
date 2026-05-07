import type Redis from 'ioredis';
import type { BarRepository } from '../../domain/marketdata/BarRepository.js';
import type {
  Bar,
  BarInterval,
} from '../../domain/marketdata/MarketDataTypes.js';

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export interface RedisBarRepositoryOptions {
  keyPrefix?: string;
  ttlSeconds?: number;
}

// Stores OHLCV series per (symbol, interval) as a JSON-encoded array under a
// single key. Keys: `cw:bars:1m:{symbol}` and `cw:bars:5m:{symbol}`.
//
// `append` is read-modify-write and not atomic across concurrent writers, but
// each symbol has a single producer (the BarStreamManager handling the WS feed),
// so contention is not expected. Both `set` and `append` refresh the TTL.
export class RedisBarRepository implements BarRepository {
  private readonly redis: Redis;
  private readonly keyPrefix: string;
  private readonly ttlSeconds: number;

  constructor(redis: Redis, options: RedisBarRepositoryOptions = {}) {
    this.redis = redis;
    this.keyPrefix = options.keyPrefix ?? 'cw:bars';
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  async get(
    symbol: string,
    interval: BarInterval,
    limit?: number,
  ): Promise<Bar[]> {
    const raw = await this.redis.get(this.key(symbol, interval));
    if (!raw) return [];
    const bars = parse(raw);
    if (limit !== undefined && limit > 0 && bars.length > limit) {
      return bars.slice(-limit);
    }
    return bars;
  }

  async set(
    symbol: string,
    interval: BarInterval,
    bars: Bar[],
  ): Promise<void> {
    await this.redis.set(
      this.key(symbol, interval),
      JSON.stringify(bars),
      'EX',
      this.ttlSeconds,
    );
  }

  async append(
    symbol: string,
    interval: BarInterval,
    bar: Bar,
  ): Promise<void> {
    const existing = await this.get(symbol, interval);
    existing.push(bar);
    await this.set(symbol, interval, existing);
  }

  async delete(symbol: string): Promise<void> {
    await this.redis.del(this.key(symbol, '1min'), this.key(symbol, '5min'));
  }

  private key(symbol: string, interval: BarInterval): string {
    const suffix = interval === '1min' ? '1m' : '5m';
    return `${this.keyPrefix}:${suffix}:${symbol}`;
  }
}

function parse(raw: string): Bar[] {
  try {
    const parsed = JSON.parse(raw) as Bar[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
