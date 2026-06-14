import type { OrderStatus } from '../../domain/broker/BrokerTypes.js';
import type { TradeContext } from '../../domain/trade/TradeTypes.js';

export function isOrderActive(status: OrderStatus): boolean {
  return (
    status === 'pending' || status === 'open' || status === 'partiallyFilled'
  );
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
