import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { Order } from '../../domain/broker/BrokerTypes.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import { logger } from '../../infrastructure/logging/logger.js';
import type { CloseTrade } from './CloseTrade.js';

const log = logger.child({ component: 'CheckOpenTrades' });

export interface CheckOpenTradesInput {
  model: string;
  symbol: string;
}

export interface CheckOpenTradesResult {
  stillExposed: boolean;
}

export interface CheckOpenTradesDeps {
  tradeRepo: TradeContextRepository;
  broker: BrokerPort;
  closeTrade: CloseTrade;
}

// Checks whether (model, symbol) still has an open trade. Reconciles the
// trade context repo against the broker as a side effect: any active context
// whose bracket has no order still alive (entry/stop/tp) is closed via
// CloseTrade. Callers use the result as a gate before evaluating new entries.
export class CheckOpenTrades {
  private readonly tradeRepo: TradeContextRepository;
  private readonly broker: BrokerPort;
  private readonly closeTrade: CloseTrade;

  constructor(deps: CheckOpenTradesDeps) {
    this.tradeRepo = deps.tradeRepo;
    this.broker = deps.broker;
    this.closeTrade = deps.closeTrade;
  }

  async execute({
    model,
    symbol,
  }: CheckOpenTradesInput): Promise<CheckOpenTradesResult> {
    const all = await this.tradeRepo.listActiveByModel(model);
    const contexts = all.filter((c) => c.symbol === symbol);
    if (contexts.length === 0) return { stillExposed: false };

    // Los contexts de (model, symbol) normalmente comparten el mismo
    // accountId (la strategy lo decide), pero por seguridad consultamos por
    // cada accountId distinto presente en los contexts. Los contexts legacy
    // sin accountId persistido no se pueden verificar contra el broker — el
    // loop de abajo los marca como cerrados con un warn.
    const accountIdsToQuery = new Set<string>();
    for (const c of contexts) {
      if (c.accountId) accountIdsToQuery.add(c.accountId);
    }
    const ordersByAccount = await Promise.all(
      Array.from(accountIdsToQuery).map((accountId) =>
        this.broker.getOrders({ symbol, accountId }),
      ),
    );
    const orders = ordersByAccount.flat();
    const activeOrderIds = new Set(
      orders.filter(isOrderActive).map((o) => o.id),
    );

    let stillExposed = false;
    for (const ctx of contexts) {
      if (!ctx.accountId) {
        // No tenemos accountId → no podemos confirmar contra el broker.
        // Cerramos el context (CloseTrade) y dejamos que la siguiente
        // evaluación abra un nuevo trade si corresponde.
        log.warn(
          {
            model,
            symbol,
            entryOrderId: ctx.bracket.entryOrderId,
          },
          'legacy trade context without accountId — closing without broker check',
        );
      }
      const bracketIds = [
        ctx.bracket.entryOrderId,
        ctx.bracket.stopOrderId,
        ctx.bracket.takeProfitOrderId,
        // Si el trade fue flateado, el Market opuesto puede seguir open
        // unos segundos hasta que llene — mantenerlo en el set evita cerrar
        // el context con la posición aún en transición.
        ctx.bracket.forcedExitOrderId,
      ].filter((id): id is string => !!id);
      const hasActive =
        !!ctx.accountId && bracketIds.some((id) => activeOrderIds.has(id));
      if (hasActive) {
        stillExposed = true;
        continue;
      }
      try {
        await this.closeTrade.execute(ctx.bracket.entryOrderId);
      } catch (err) {
        log.warn(
          {
            model,
            symbol,
            entryOrderId: ctx.bracket.entryOrderId,
            err: errMsg(err),
          },
          'failed to mark trade context closed',
        );
      }
    }
    return { stillExposed };
  }
}

function isOrderActive(o: Order): boolean {
  return (
    o.status === 'open' ||
    o.status === 'pending' ||
    o.status === 'partiallyFilled'
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
