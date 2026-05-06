import type Redis from 'ioredis';
import type { TradedSymbolsRepository } from '../../domain/trade/TradedSymbolsRepository.js';

export interface RedisTradedSymbolsRepositoryOptions {
  keyPrefix?: string;
}

export class RedisTradedSymbolsRepository implements TradedSymbolsRepository {
  private readonly redis: Redis;
  private readonly setKey: string;

  constructor(redis: Redis, options: RedisTradedSymbolsRepositoryOptions = {}) {
    this.redis = redis;
    const prefix = options.keyPrefix ?? 'cw:traded';
    this.setKey = `${prefix}:symbols`;
  }

  async has(symbol: string): Promise<boolean> {
    const result = await this.redis.sismember(this.setKey, symbol);
    return result === 1;
  }

  async add(symbol: string): Promise<void> {
    await this.redis.sadd(this.setKey, symbol);
  }
}
