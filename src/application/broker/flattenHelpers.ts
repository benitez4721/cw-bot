import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type {
  OrderSide,
  OrderStatus,
  Quote,
} from '../../domain/broker/BrokerTypes.js';
import type { TradeContext } from '../../domain/trade/TradeTypes.js';
import { bpsToFraction, round2 } from '../../domain/shared/math.js';
import { sleep } from '../../shared/async.js';

export function isOrderActive(status: OrderStatus): boolean {
  return (
    status === 'pending' || status === 'open' || status === 'partiallyFilled'
  );
}

// Precio marketable para salir cruzando el spread: al vender (exit long)
// cruzamos por debajo del bid; al comprar (exit short), por encima del ask.
// Cae a `last` si falta el lado del libro. undefined si no hay precio usable.
export function crossTheSpread(
  quote: Quote,
  side: OrderSide,
  offsetBps: number,
): number | undefined {
  const offset = bpsToFraction(offsetBps);
  const base =
    side === 'SELL' ? (quote.bid ?? quote.last) : (quote.ask ?? quote.last);
  if (!Number.isFinite(base) || base <= 0) return undefined;
  const raw = side === 'SELL' ? base * (1 - offset) : base * (1 + offset);
  return round2(raw);
}

// Polea getOrders hasta que las órdenes dadas queden en estado terminal (ya no
// activas) o se agote el timeout. Devuelve true si todas terminaron. Usado para
// confirmar una cancelación antes de mandar la orden de reemplazo (evita doble
// fill / rechazos de riesgo de TS).
export async function waitOrdersTerminal(
  broker: BrokerPort,
  orderIds: readonly string[],
  accountId: string,
  opts: { timeoutMs: number; pollMs: number },
): Promise<boolean> {
  if (orderIds.length === 0) return true;
  const idSet = new Set(orderIds);
  const deadline = Date.now() + opts.timeoutMs;
  while (true) {
    const currentOrders = await broker.getOrders({ accountId });
    const stillActive = currentOrders.some(
      (o) => idSet.has(o.id) && isOrderActive(o.status),
    );
    if (!stillActive) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(opts.pollMs, remaining));
  }
}

export function groupByAccountAndSymbol(
  contexts: TradeContext[],
): Map<string, TradeContext[]> {
  const out = new Map<string, TradeContext[]>();
  for (const ctx of contexts) {
    const key = `${ctx.accountId}:${ctx.symbol}`;
    const bucket = out.get(key) ?? [];
    bucket.push(ctx);
    out.set(key, bucket);
  }
  return out;
}
