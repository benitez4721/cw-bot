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

    const orders = await this.broker.getOrders({ symbol });
    const activeOrderIds = new Set(
      orders.filter(isOrderActive).map((o) => o.id),
    );

    let stillExposed = false;
    for (const ctx of contexts) {
      const bracketIds = [
        ctx.bracket.entryOrderId,
        ctx.bracket.stopOrderId,
        ctx.bracket.takeProfitOrderId,
        // Si el trade fue flateado, el Market opuesto puede seguir open
        // unos segundos hasta que llene — mantenerlo en el set evita cerrar
        // el context con la posición aún en transición.
        ctx.bracket.forcedExitOrderId,
      ].filter((id): id is string => !!id);
      const hasActive = bracketIds.some((id) => activeOrderIds.has(id));
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
