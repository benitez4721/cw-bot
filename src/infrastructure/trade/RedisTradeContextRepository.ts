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
    const activeKey = this.activeKey(ctx.model, ctx.symbol);
    const serialized = JSON.stringify(ctx);
    const tx = this.redis
      .multi()
      .sadd(this.indexKey, entryOrderId)
      .set(this.itemKey(entryOrderId), serialized, 'EX', this.itemTtlSeconds);
    // Dual-write: si el trade fue flateado, indexamos también bajo el
    // OrderID del Market opuesto. Permite que OrderStreamManager enriquezca
    // el evento de ese Market con este TradeContext (mismo JSON) y el
    // dashboard agrupe los 4 OrderIDs como un solo trade.
    if (ctx.bracket.forcedExitOrderId) {
      tx.set(
        this.itemKey(ctx.bracket.forcedExitOrderId),
        serialized,
        'EX',
        this.itemTtlSeconds,
      );
    }
    if (ctx.status === 'closed') {
      tx.srem(activeKey, entryOrderId);
    } else {
      tx.sadd(activeKey, entryOrderId);
    }
    await tx.exec();
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

  // Itera el índice global de entryOrderIds, materializa los items vivos en
  // Redis y devuelve solo los activos. Aceptable para cardinalidad baja
  // (decenas de trades por día, TTL 7d sobre los items). El flatten pre-close
  // es la única ruta que lo invoca, una vez por día.
  async listAllActive(): Promise<TradeContext[]> {
    const ids = await this.redis.smembers(this.indexKey);
    if (ids.length === 0) return [];

    const raws = await this.redis.mget(...ids.map((id) => this.itemKey(id)));
    const out: TradeContext[] = [];
    for (let i = 0; i < ids.length; i++) {
      const raw = raws[i];
      if (!raw) continue;
      const parsed = parseItem(raw);
      if (!parsed) continue;
      if (parsed.status !== 'active') continue;
      out.push(parsed);
    }
    return out;
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
