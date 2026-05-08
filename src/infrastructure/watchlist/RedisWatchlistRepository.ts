import type Redis from 'ioredis';
import type { WatchlistRepository } from '../../domain/watchlist/WatchlistRepository.js';
import type { WatchedSymbol } from '../../domain/watchlist/WatchlistTypes.js';

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface RedisWatchlistRepositoryOptions {
  keyPrefix?: string;
  itemTtlSeconds?: number;
}

export class RedisWatchlistRepository implements WatchlistRepository {
  private readonly redis: Redis;
  private readonly indexKey: string;
  private readonly itemPrefix: string;
  private readonly itemTtlSeconds: number;

  constructor(redis: Redis, options: RedisWatchlistRepositoryOptions = {}) {
    this.redis = redis;
    const prefix = options.keyPrefix ?? 'cw:wl';
    this.indexKey = `${prefix}:idx`;
    this.itemPrefix = `${prefix}:item:`;
    this.itemTtlSeconds = options.itemTtlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  async put(symbol: WatchedSymbol): Promise<void> {
    const itemKey = this.itemKey(symbol.symbol);
    const payload = JSON.stringify(symbol);
    await this.redis
      .multi()
      .sadd(this.indexKey, symbol.symbol)
      .set(itemKey, payload, 'EX', this.itemTtlSeconds)
      .exec();
  }

  async getBySymbol(symbol: string): Promise<WatchedSymbol | undefined> {
    const raw = await this.redis.get(this.itemKey(symbol));
    if (!raw) return undefined;
    return parseItem(raw);
  }

  async list(): Promise<WatchedSymbol[]> {
    const symbols = await this.redis.smembers(this.indexKey);
    if (symbols.length === 0) return [];
    const keys = symbols.map((s) => this.itemKey(s));
    const raws = await this.redis.mget(...keys);
    const items: WatchedSymbol[] = [];
    const expired: string[] = [];
    for (let i = 0; i < symbols.length; i++) {
      const raw = raws[i];
      if (!raw) {
        expired.push(symbols[i]);
        continue;
      }
      const parsed = parseItem(raw);
      if (parsed) items.push(parsed);
    }
    if (expired.length > 0) {
      await this.redis.srem(this.indexKey, ...expired);
    }
    return items;
  }

  private itemKey(symbol: string): string {
    return `${this.itemPrefix}${symbol}`;
  }
}

function parseItem(raw: string): WatchedSymbol | undefined {
  try {
    return JSON.parse(raw) as WatchedSymbol;
  } catch {
    return undefined;
  }
}
