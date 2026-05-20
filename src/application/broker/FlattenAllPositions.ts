import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type {
  Order,
  OrderSide,
  OrderStatus,
} from '../../domain/broker/BrokerTypes.js';
import type { MetricsPort } from '../../domain/metrics/MetricsPort.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../domain/trade/TradeTypes.js';
import { logger } from '../../infrastructure/logging/logger.js';

const log = logger.child({ component: 'FlattenAllPositions' });

export interface FlattenAllPositionsDeps {
  broker: BrokerPort;
  tradeRepo: TradeContextRepository;
  metrics: MetricsPort;
}

// Cierre forzado pre-close de todas las posiciones / entries abiertos del bot.
//
// Por cada TradeContext activo (cross-model, cross-symbol):
//   - Entry pendiente sin llenar → cancelOrder(entry). El OSO BRK cancela los
//     exits automáticamente.
//   - Posición abierta → cancela stop+TP del bracket y envía un Market opuesto
//     por el qty agregado de la posición. Persiste el OrderID del Market en
//     `forcedExitOrderId` del TradeContext para que el dashboard agrupe el
//     Market con el bracket original (4ta pierna del trade).
//
// Multi-context por símbolo (multi-estrategia) → un único Market por símbolo
// y se propaga el mismo forcedExitOrderId a cada context del símbolo.
export class FlattenAllPositions {
  private readonly broker: BrokerPort;
  private readonly tradeRepo: TradeContextRepository;
  private readonly metrics: MetricsPort;

  constructor(deps: FlattenAllPositionsDeps) {
    this.broker = deps.broker;
    this.tradeRepo = deps.tradeRepo;
    this.metrics = deps.metrics;
  }

  async execute(): Promise<void> {
    const [orders, positions, activeContexts] = await Promise.all([
      this.broker.getOrders({}),
      this.broker.getPositions(),
      this.tradeRepo.listAllActive(),
    ]);

    if (activeContexts.length === 0) {
      log.info('no active trade contexts; nothing to flatten');
      return;
    }

    const bySymbol = groupBySymbol(activeContexts);

    // Cross-symbol en paralelo; mismo símbolo serial para no carrera con
    // qty agregada (un solo Market opuesto por símbolo).
    await Promise.allSettled(
      Array.from(bySymbol.values()).map((ctxs) =>
        this.flattenSymbol(ctxs, orders, positions),
      ),
    );
  }

  private async flattenSymbol(
    contexts: TradeContext[],
    orders: Order[],
    positions: Awaited<ReturnType<BrokerPort['getPositions']>>,
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
            accountId: ctx.accountId,
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
          this.broker.cancelOrder({ orderId, accountId: ctx.accountId }),
        ),
      );

      // Solo el primer ctx del símbolo envía el Market (qty agregada).
      // Los siguientes reusan el mismo forcedExitOrderId.
      if (!marketOrderId) {
        const side: OrderSide = position.quantity > 0 ? 'SELL' : 'BUY';
        const qty = Math.abs(position.quantity);
        try {
          const result = await this.broker.placeMarketOrder({
            symbol: ctx.symbol,
            quantity: qty,
            side,
            accountId: ctx.accountId,
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

function groupBySymbol(contexts: TradeContext[]): Map<string, TradeContext[]> {
  const out = new Map<string, TradeContext[]>();
  for (const ctx of contexts) {
    const bucket = out.get(ctx.symbol) ?? [];
    bucket.push(ctx);
    out.set(ctx.symbol, bucket);
  }
  return out;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
