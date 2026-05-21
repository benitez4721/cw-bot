import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type {
  Order,
  OrderSide,
  OrderStatus,
  Position,
} from '../../domain/broker/BrokerTypes.js';
import type { MetricsPort } from '../../domain/metrics/MetricsPort.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../domain/trade/TradeTypes.js';
import { logger } from '../../infrastructure/logging/logger.js';

const log = logger.child({ component: 'FlattenAllPositions' });

export interface FlattenAllPositionsDeps {
  broker: BrokerPort;
  // Set de cuentas a barrer al traer orders/positions. Es la unión de los
  // `accountId` declarados por las estrategias activas.
  accountIds: readonly string[];
  tradeRepo: TradeContextRepository;
  metrics: MetricsPort;
}

// Cierre forzado pre-close de todas las posiciones / entries abiertos del bot.
//
// Por cada TradeContext activo (cross-model, cross-symbol, cross-account):
//   - Entry pendiente sin llenar → cancelOrder(entry). El OSO BRK cancela los
//     exits automáticamente.
//   - Posición abierta → cancela stop+TP del bracket y envía un Market opuesto
//     por el qty agregado de la posición. Persiste el OrderID del Market en
//     `forcedExitOrderId` del TradeContext para que el dashboard agrupe el
//     Market con el bracket original (4ta pierna del trade).
//
// Multi-context por (accountId, symbol) → un único Market por (accountId,
// symbol) y se propaga el mismo forcedExitOrderId a cada context del grupo.
// Dos estrategias en accounts distintos con AAPL se cierran independientes
// (cada account envía su propio Market) porque la position se busca solo en
// el snapshot del accountId del grupo.
export class FlattenAllPositions {
  private readonly broker: BrokerPort;
  private readonly accountIds: readonly string[];
  private readonly tradeRepo: TradeContextRepository;
  private readonly metrics: MetricsPort;

  constructor(deps: FlattenAllPositionsDeps) {
    this.broker = deps.broker;
    this.accountIds = deps.accountIds;
    this.tradeRepo = deps.tradeRepo;
    this.metrics = deps.metrics;
  }

  async execute(): Promise<void> {
    const activeContexts = await this.tradeRepo.listAllActive();
    if (activeContexts.length === 0) {
      log.info('no active trade contexts; nothing to flatten');
      return;
    }

    // Orders se concatenan: orderId es único cross-account, así que
    // `orders.find(id)` no se confunde. Positions se mantienen indexadas por
    // accountId para que la búsqueda por symbol no cruce cuentas.
    const ordersAndPositions = await Promise.all(
      this.accountIds.map(async (accountId) => {
        const [orders, positions] = await Promise.all([
          this.broker.getOrders({ accountId }),
          this.broker.getPositions({ accountId }),
        ]);
        return { accountId, orders, positions };
      }),
    );
    const orders = ordersAndPositions.flatMap((r) => r.orders);
    const positionsByAccount = new Map<string, Position[]>(
      ordersAndPositions.map((r) => [r.accountId, r.positions]),
    );

    // Filtra contexts legacy sin accountId persistido — no podemos resolver
    // SIM/LIVE para cancelar/Market. Quedan en Redis hasta que CheckOpenTrades
    // los cierre (vence el TTL en pocos días).
    const flattenable = activeContexts.filter((ctx) => {
      if (ctx.accountId) return true;
      log.warn(
        {
          symbol: ctx.symbol,
          model: ctx.model,
          entryOrderId: ctx.bracket.entryOrderId,
        },
        'skipping legacy trade context without accountId',
      );
      return false;
    });

    const byAccountSymbol = groupByAccountAndSymbol(flattenable);

    // Cross-grupo en paralelo; serial dentro del grupo (un solo Market
    // opuesto por (account, symbol) con qty agregada).
    await Promise.allSettled(
      Array.from(byAccountSymbol.values()).map((ctxs) => {
        // Garantizado por el filter de arriba (todos los ctx del grupo
        // comparten el accountId del key).
        const accountId = ctxs[0].accountId!;
        const positions = positionsByAccount.get(accountId) ?? [];
        return this.flattenSymbol(ctxs, accountId, orders, positions);
      }),
    );
  }

  private async flattenSymbol(
    contexts: TradeContext[],
    accountId: string,
    orders: Order[],
    positions: Position[],
  ): Promise<void> {
    let marketOrderId: string | null = null;
    const position = positions.find(
      (p) => p.symbol === contexts[0].symbol && p.quantity !== 0,
    );

    for (const ctx of contexts) {
      const entryOrder = orders.find((o) => o.id === ctx.bracket.entryOrderId);

      // Caso A — entry sin llenar
      if (entryOrder && isOrderActive(entryOrder.status)) {
        try {
          await this.broker.cancelOrder({
            orderId: ctx.bracket.entryOrderId,
            accountId,
          });
          this.metrics.recordFlattenOutcome('cancelled');
          log.info(
            {
              symbol: ctx.symbol,
              model: ctx.model,
              entryOrderId: ctx.bracket.entryOrderId,
            },
            'entry cancelled before close',
          );
        } catch (err) {
          this.metrics.recordFlattenFailure('cancel');
          log.error(
            { symbol: ctx.symbol, err: errMsg(err) },
            'failed to cancel entry',
          );
        }
        continue;
      }

      // Caso C — sin entry pendiente y sin posición
      if (!position) {
        this.metrics.recordFlattenOutcome('skipped');
        log.info(
          {
            symbol: ctx.symbol,
            model: ctx.model,
            entryOrderId: ctx.bracket.entryOrderId,
          },
          'no entry pending and no position; nothing to do',
        );
        continue;
      }

      // Caso B — posición abierta: cancela exits del bracket
      const exitIds = [
        ctx.bracket.stopOrderId,
        ctx.bracket.takeProfitOrderId,
      ].filter((id): id is string => !!id);
      await Promise.allSettled(
        exitIds.map((orderId) =>
          this.broker.cancelOrder({ orderId, accountId }),
        ),
      );

      // Solo el primer ctx del grupo envía el Market (qty agregada).
      // Los siguientes reusan el mismo forcedExitOrderId.
      if (!marketOrderId) {
        const side: OrderSide = position.quantity > 0 ? 'SELL' : 'BUY';
        const qty = Math.abs(position.quantity);
        try {
          const result = await this.broker.placeMarketOrder({
            symbol: ctx.symbol,
            quantity: qty,
            side,
            accountId,
          });
          if (
            !result.orderId ||
            result.status === 'rejected' ||
            result.status === 'expired'
          ) {
            this.metrics.recordFlattenFailure('market');
            log.error(
              {
                symbol: ctx.symbol,
                side,
                qty,
                status: result.status,
                error: result.error,
                message: result.message,
              },
              'placeMarketOrder rejected — position remains open',
            );
            continue;
          }
          marketOrderId = result.orderId;
          log.info(
            { symbol: ctx.symbol, side, qty, marketOrderId },
            'flatten market sent',
          );
        } catch (err) {
          this.metrics.recordFlattenFailure('market');
          log.error(
            { symbol: ctx.symbol, err: errMsg(err) },
            'placeMarketOrder threw',
          );
          continue;
        }
      }

      try {
        await this.tradeRepo.put({
          ...ctx,
          bracket: { ...ctx.bracket, forcedExitOrderId: marketOrderId },
        });
        this.metrics.recordFlattenOutcome('marketSent');
      } catch (err) {
        this.metrics.recordFlattenFailure('persist');
        log.warn(
          {
            symbol: ctx.symbol,
            model: ctx.model,
            entryOrderId: ctx.bracket.entryOrderId,
            forcedExitOrderId: marketOrderId,
            err: errMsg(err),
          },
          'failed to persist forcedExitOrderId; market already sent',
        );
      }
    }
  }
}

function isOrderActive(status: OrderStatus): boolean {
  return (
    status === 'pending' || status === 'open' || status === 'partiallyFilled'
  );
}

// Asume que cada ctx tiene `accountId` seteado (el caller filtra legacy).
function groupByAccountAndSymbol(
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

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
