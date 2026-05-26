import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { Order, Position } from '../../domain/broker/BrokerTypes.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../domain/trade/TradeTypes.js';
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
    // En sesion pre el bot no coloca StopMarket ni TP en el broker — el
    // unico residuo broker-side es la entry Limit, que se vuelve filled (no
    // active) en cuanto llena. Para esos ctx, "no hay ordenes activas" NO
    // implica "trade cerrado": la posicion sigue abierta hasta que dispare
    // el exit sintetico (CheckSyntheticStops) o el flatten 9:20. Por eso
    // tambien consultamos positions cuando hay al menos un ctx pre vivo.
    const needsPositions = contexts.some(isPreCtxBracketless);
    const accountIdsArr = Array.from(accountIdsToQuery);
    const [ordersByAccount, positionsByAccount] = await Promise.all([
      Promise.all(
        accountIdsArr.map((accountId) =>
          this.broker.getOrders({ symbol, accountId }),
        ),
      ),
      needsPositions
        ? Promise.all(
            accountIdsArr.map((accountId) =>
              this.broker.getPositions({ accountId }),
            ),
          )
        : Promise.resolve<Position[][]>([]),
    ]);
    const orders = ordersByAccount.flat();
    const positions = positionsByAccount.flat();
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
      // Fallback pre: si no hay orden activa pero el ctx es pre con la
      // posicion todavia abierta en el broker, el trade sigue vivo (a la
      // espera del exit sintetico). No cerrar el ctx ni habilitar entries
      // duplicados.
      if (isPreCtxBracketless(ctx) && ctx.accountId) {
        const hasPosition = positions.some(
          (p) =>
            p.accountId === ctx.accountId &&
            p.symbol === symbol &&
            p.quantity !== 0,
        );
        if (hasPosition) {
          stillExposed = true;
          continue;
        }
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

// Ctx pre que aun no disparo exit sintetico: el unico residuo en el broker
// es la entry filled; el monitoreo del trade vive en TradeContext.stopPrice
// y la position abierta. Si syntheticExitFired ya es true, el exit Limit
// existe como forcedExitOrderId y se chequea via activeOrderIds — no
// necesitamos el fallback de positions.
function isPreCtxBracketless(ctx: TradeContext): boolean {
  return ctx.session === 'pre' && !ctx.syntheticExitFired;
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
