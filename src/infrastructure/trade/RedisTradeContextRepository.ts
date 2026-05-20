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
  private readonly modelActivePrefix: string;
  private readonly itemTtlSeconds: number;

  constructor(redis: Redis, options: RedisTradeContextRepositoryOptions = {}) {
    this.redis = redis;
    const prefix = options.keyPrefix ?? 'cw:trade';
    this.indexKey = `${prefix}:idx`;
    this.itemPrefix = `${prefix}:item:`;
    this.modelActivePrefix = `${prefix}:modelActive:`;
    this.itemTtlSeconds = options.itemTtlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  async put(ctx: TradeContext): Promise<void> {
    const entryOrderId = ctx.bracket.entryOrderId;
    const modelActiveKey = this.modelActiveKey(ctx.model);
    const serialized = JSON.stringify(ctx);
    const tx = this.redis
      .multi()
      .sadd(this.indexKey, entryOrderId)
      .set(this.itemKey(entryOrderId), serialized, 'EX', this.itemTtlSeconds);
    // Dual-write bajo cada pierna del bracket (stop, take-profit, forced).
    // OrderStreamManager hace getByOrderId(event.order.id) para enriquecer el
    // evento; sin este dual-write los eventos de stop/TP no encontrarían el
    // context y RecordOrderFill no podría persistir el exit fill.
    const secondaryIds = [
      ctx.bracket.stopOrderId,
      ctx.bracket.takeProfitOrderId,
      ctx.bracket.forcedExitOrderId,
    ].filter((id): id is string => !!id && id !== entryOrderId);
    for (const id of secondaryIds) {
      tx.set(this.itemKey(id), serialized, 'EX', this.itemTtlSeconds);
    }
    if (ctx.status === 'closed') {
      tx.srem(modelActiveKey, entryOrderId);
    } else {
      tx.sadd(modelActiveKey, entryOrderId);
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

  async listActiveByModel(model: string): Promise<TradeContext[]> {
    const setKey = this.modelActiveKey(model);
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

  private modelActiveKey(model: string): string {
    return `${this.modelActivePrefix}${model}`;
  }
}

function parseItem(raw: string): TradeContext | undefined {
  try {
    return JSON.parse(raw) as TradeContext;
  } catch {
    return undefined;
  }
}
