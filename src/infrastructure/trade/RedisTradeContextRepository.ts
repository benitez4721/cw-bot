import type Redis from 'ioredis';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../domain/trade/TradeTypes.js';

const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface RedisTradeContextRepositoryOptions {
  keyPrefix?: string;
  itemTtlSeconds?: number;
}

export class RedisTradeContextRepository implements TradeContextRepository {
  private readonly redis: Redis;
  private readonly indexKey: string;
  private readonly itemPrefix: string;
  private readonly itemTtlSeconds: number;

  constructor(redis: Redis, options: RedisTradeContextRepositoryOptions = {}) {
    this.redis = redis;
    const prefix = options.keyPrefix ?? 'cw:trade';
    this.indexKey = `${prefix}:idx`;
    this.itemPrefix = `${prefix}:item:`;
    this.itemTtlSeconds = options.itemTtlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  async insert(ctx: TradeContext): Promise<void> {
    const exists = await this.redis.exists(this.itemKey(ctx.orderId));
    if (exists) {
      throw new Error(
        `TradeContext already exists for orderId: ${ctx.orderId}`,
      );
    }
    await this.redis
      .multi()
      .sadd(this.indexKey, ctx.orderId)
      .set(
        this.itemKey(ctx.orderId),
        JSON.stringify(ctx),
        'EX',
        this.itemTtlSeconds,
      )
      .exec();
  }

  async getByOrderId(orderId: string): Promise<TradeContext | undefined> {
    const raw = await this.redis.get(this.itemKey(orderId));
    if (!raw) return undefined;
    return parseItem(raw);
  }

  async getByOrderIds(orderIds: string[]): Promise<Map<string, TradeContext>> {
    const result = new Map<string, TradeContext>();
    if (orderIds.length === 0) return result;
    const keys = orderIds.map((id) => this.itemKey(id));
    const raws = await this.redis.mget(...keys);
    for (let i = 0; i < orderIds.length; i++) {
      const raw = raws[i];
      if (!raw) continue;
      const parsed = parseItem(raw);
      if (parsed) result.set(orderIds[i], parsed);
    }
    return result;
  }

  private itemKey(orderId: string): string {
    return `${this.itemPrefix}${orderId}`;
  }
}

function parseItem(raw: string): TradeContext | undefined {
  try {
    return JSON.parse(raw) as TradeContext;
  } catch {
    return undefined;
  }
}
