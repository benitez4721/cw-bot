import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { Order } from '../../domain/broker/BrokerTypes.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { errMsg } from '../../shared/errors.js';
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

// Checks whether (model, symbol) still has an open trade. Callers use the
// result as a gate before evaluating new entries.
//
// Dos regímenes según la sesión del context:
//   - pre: gate puro sobre Redis. En pre el bot no deja órdenes de exit
//     nativas en el broker (el stop es un Limit sintético que se cancela y
//     recoloca cada barra) y la posición del broker es neta-agregada por
//     cuenta+symbol — no distingue ctx cuando varios trades comparten symbol.
//     Leer el broker acá producía falsos "sin exposición" en las ventanas de
//     repeg (entry ya lleno + exit en tránsito) y abría trades duplicados. La
//     verdad por-ctx vive en Redis: un ctx pre activo == símbolo expuesto. El
//     cierre del ctx lo disparan RecordOrderFill (OrderStream), el self-heal
//     de MaybeRepegSyntheticExit y el flatten 9:20 — nunca este gate.
//   - rth: el bracket nativo deja stop/TP como órdenes vivas identificables
//     por orderId. Reconcilia el repo contra el broker como efecto colateral:
//     un context sin ninguna pierna del bracket aún activa se cierra via
//     CloseTrade.
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

    // Gate pre: cualquier ctx pre activo basta para considerar el símbolo
    // expuesto, sin consultar el broker ni cerrar nada (ver comentario de
    // clase). Si hay contexts mixtos, el pre activo ya cubre la exposición;
    // los rth se reconcilian en una vuelta posterior cuando ya no quede pre.
    if (contexts.some((c) => c.session === 'pre')) {
      return { stillExposed: true };
    }

    // rth: los contexts normalmente comparten el mismo accountId (la strategy
    // lo decide), pero por seguridad consultamos por cada accountId distinto.
    // Los contexts legacy sin accountId no se pueden verificar contra el
    // broker — el loop de abajo los cierra con un warn.
    const accountIdsToQuery = new Set<string>();
    for (const c of contexts) {
      if (c.accountId) accountIdsToQuery.add(c.accountId);
    }
    const ordersByAccount = await Promise.all(
      Array.from(accountIdsToQuery, (accountId) =>
        this.broker.getOrders({ symbol, accountId }),
      ),
    );
    const activeOrderIds = new Set(
      ordersByAccount
        .flat()
        .filter(isOrderActive)
        .map((o) => o.id),
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
