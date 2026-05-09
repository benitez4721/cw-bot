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
  private readonly activePrefix: string;
  private readonly itemTtlSeconds: number;

  constructor(redis: Redis, options: RedisTradeContextRepositoryOptions = {}) {
    this.redis = redis;
    const prefix = options.keyPrefix ?? 'cw:trade';
    this.indexKey = `${prefix}:idx`;
    this.itemPrefix = `${prefix}:item:`;
    this.activePrefix = `${prefix}:active:`;
    this.itemTtlSeconds = options.itemTtlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  async put(ctx: TradeContext): Promise<void> {
    const entryOrderId = ctx.bracket.entryOrderId;
    await this.redis
      .multi()
      .sadd(this.indexKey, entryOrderId)
      .sadd(this.activeKey(ctx.model, ctx.symbol), entryOrderId)
      .set(
        this.itemKey(entryOrderId),
        JSON.stringify(ctx),
        'EX',
        this.itemTtlSeconds,
      )
      .exec();
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

  async listActiveByModelAndSymbol(
    model: string,
    symbol: string,
  ): Promise<TradeContext[]> {
    const setKey = this.activeKey(model, symbol);
    const ids = await this.redis.smembers(setKey);
    if (ids.length === 0) return [];

    const raws = await this.redis.mget(...ids.map((id) => this.itemKey(id)));
    const out: TradeContext[] = [];
    const expired: string[] = [];

    for (let i = 0; i < ids.length; i++) {
      const raw = raws[i];
      if (!raw) {
        expired.push(ids[i]);
        continue;
      }
      const parsed = parseItem(raw);
      if (!parsed) continue;
      out.push(parsed);
    }

    if (expired.length > 0) {
      await this.redis.srem(setKey, ...expired);
    }

    return out;
  }

  async markClosed(entryOrderId: string): Promise<void> {
    const raw = await this.redis.get(this.itemKey(entryOrderId));
    if (!raw) return;
    const ctx = parseItem(raw);
    if (!ctx) return;
    const updated: TradeContext = { ...ctx, status: 'closed' };
    await this.redis
      .multi()
      .set(
        this.itemKey(entryOrderId),
        JSON.stringify(updated),
        'EX',
        this.itemTtlSeconds,
      )
      .srem(this.activeKey(ctx.model, ctx.symbol), entryOrderId)
      .exec();
  }

  private itemKey(orderId: string): string {
    return `${this.itemPrefix}${orderId}`;
  }

  private activeKey(model: string, symbol: string): string {
    return `${this.activePrefix}${model}:${symbol}`;
  }
}

function parseItem(raw: string): TradeContext | undefined {
  try {
    return JSON.parse(raw) as TradeContext;
  } catch {
    return undefined;
  }
}
