import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type {
  Order,
  OrderSide,
  Position,
  Quote,
} from '../../domain/broker/BrokerTypes.js';
import type { MetricsPort } from '../../domain/metrics/MetricsPort.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../domain/trade/TradeTypes.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { errMsg } from '../../shared/errors.js';
import {
  crossTheSpread,
  groupByAccountAndSymbol,
  isOrderActive,
  waitOrdersTerminal,
} from './flattenHelpers.js';
import type { PlaceLimitOrder } from './PlaceLimitOrder.js';

const log = logger.child({ component: 'FlattenPrePositions' });

// Offset cross-the-spread para el flatten 9:20 — igual logica que
// CheckSyntheticStops pero invocado una unica vez en el boundary pre→transition.
const DEFAULT_PARAMS = {
  crossOffsetBps: 5,
  cancelConfirmTimeoutMs: 3000,
  cancelPollIntervalMs: 200,
} as const;

export interface FlattenPrePositionsDeps {
  broker: BrokerPort;
  accountIds: readonly string[];
  tradeRepo: TradeContextRepository;
  placeLimitOrder: PlaceLimitOrder;
  metrics: MetricsPort;
}

// Cierre forzado de todas las posiciones pre antes de cruzar a RTH (9:20 ET).
//
// Por cada TradeContext con session: 'pre' (haya o no disparado ya un exit
// sintetico — el repeg pudo dejar un Limit vivo que aun no llena):
//   - Entry pendiente sin llenar → cancelOrder(entry). No hay OSO en pre, no
//     hay exits que cancelar.
//   - Posicion abierta → antes de mandar el flatten, cancela cualquier Limit de
//     salida vivo del grupo (forcedExitOrderId del repeg) y confirma terminal,
//     para no dejar dos Limits compitiendo. Luego placeLimitOrder
//     cross-the-spread con duration: 'DYP' y route: 'ARCA' (Market no fillea en
//     extended hours).
//
// Multi-context por (accountId, symbol) → manda un unico Limit con qty
// agregada de la posicion. Si dos estrategias entraron al mismo symbol en pre,
// se comparten el exit; cada ctx del grupo registra el mismo forcedExitOrderId.
//
// Idempotencia diaria: lo dispara SessionBoundaryRunner.triggerPreFlatten una
// sola vez por dia NY; persiste forcedExitOrderId tras enviar el flatten.
export class FlattenPrePositions {
  private readonly broker: BrokerPort;
  private readonly accountIds: readonly string[];
  private readonly tradeRepo: TradeContextRepository;
  private readonly placeLimitOrder: PlaceLimitOrder;
  private readonly metrics: MetricsPort;

  constructor(deps: FlattenPrePositionsDeps) {
    this.broker = deps.broker;
    this.accountIds = deps.accountIds;
    this.tradeRepo = deps.tradeRepo;
    this.placeLimitOrder = deps.placeLimitOrder;
    this.metrics = deps.metrics;
  }

  async execute(): Promise<void> {
    const active = await this.tradeRepo.listAllActive();
    const flattenable = active.filter(
      (ctx) => ctx.session === 'pre' && !!ctx.accountId,
    );
    if (flattenable.length === 0) {
      log.info('no active pre-market contexts; nothing to flatten');
      return;
    }

    const ordersAndPositions = await Promise.all(
      this.accountIds.map(async (accountId) => {
        const [orders, positions] = await Promise.all([
          this.broker.getOrders({ accountId }),
          this.broker.getPositions({ accountId }),
        ]);
        return { orders, positions };
      }),
    );
    const orders = ordersAndPositions.flatMap((r) => r.orders);
    const positions = ordersAndPositions.flatMap((r) => r.positions);

    const byAccountSymbol = groupByAccountAndSymbol(flattenable);

    await Promise.allSettled(
      Array.from(byAccountSymbol.values()).map((ctxs) => {
        const accountId = ctxs[0].accountId!;
        return this.flattenGroup(ctxs, accountId, orders, positions);
      }),
    );
  }

  private async flattenGroup(
    contexts: TradeContext[],
    accountId: string,
    orders: Order[],
    positions: Position[],
  ): Promise<void> {
    const symbol = contexts[0].symbol;
    const position = positions.find(
      (p) =>
        p.accountId === accountId && p.symbol === symbol && p.quantity !== 0,
    );

    const ctxsWithEntryPending: TradeContext[] = [];
    const ctxsToExit: TradeContext[] = [];
    for (const ctx of contexts) {
      const entryOrder = orders.find((o) => o.id === ctx.bracket.entryOrderId);
      if (entryOrder && isOrderActive(entryOrder.status)) {
        ctxsWithEntryPending.push(ctx);
      } else if (position) {
        ctxsToExit.push(ctx);
      } else {
        this.metrics.recordFlattenOutcome('skipped');
        log.info(
          {
            symbol: ctx.symbol,
            model: ctx.model,
            entryOrderId: ctx.bracket.entryOrderId,
          },
          'no entry pending and no position in pre; nothing to do',
        );
      }
    }

    await Promise.allSettled(
      ctxsWithEntryPending.map((ctx) => this.cancelEntry(ctx, accountId)),
    );

    if (ctxsToExit.length === 0) return;

    // Cancelar cualquier Limit de salida vivo (del re-peg) antes del flatten:
    // evita dos Limits compitiendo por la misma posicion. Confirmamos terminal
    // para que TS no rechace el nuevo por "remaining on sell orders".
    const liveExitIds = ctxsToExit
      .map((ctx) => ctx.bracket.forcedExitOrderId)
      .filter((id): id is string => !!id);
    if (liveExitIds.length > 0) {
      await Promise.allSettled(
        liveExitIds.map((orderId) =>
          this.broker.cancelOrder({ orderId, accountId }),
        ),
      );
      const terminal = await waitOrdersTerminal(
        this.broker,
        liveExitIds,
        accountId,
        {
          timeoutMs: DEFAULT_PARAMS.cancelConfirmTimeoutMs,
          pollMs: DEFAULT_PARAMS.cancelPollIntervalMs,
        },
      );
      if (!terminal) {
        this.metrics.recordFlattenFailure('cancelTimeout');
        log.error(
          { symbol, accountId, liveExitIds },
          'pre exit limits still active after cancel — skipping flatten to avoid double Limit',
        );
        return;
      }
    }

    let quote: Quote;
    try {
      quote = await this.broker.getQuote({ symbol, accountId });
    } catch (err) {
      this.metrics.recordFlattenFailure('market');
      log.error(
        { symbol, accountId, err: errMsg(err) },
        'getQuote threw — cannot resolve cross-the-spread limit price',
      );
      return;
    }

    const side: OrderSide = position!.quantity > 0 ? 'SELL' : 'BUY';
    const qty = Math.abs(position!.quantity);
    const limitPrice = crossTheSpread(
      quote,
      side,
      DEFAULT_PARAMS.crossOffsetBps,
    );
    if (limitPrice === undefined) {
      this.metrics.recordFlattenFailure('market');
      log.error(
        { symbol, quote },
        'quote has no usable price for flatten — position remains open',
      );
      return;
    }

    let exitOrderId: string;
    try {
      const result = await this.placeLimitOrder.execute({
        symbol,
        quantity: qty,
        side,
        limitPrice,
        accountId,
        duration: 'DYP',
        route: 'ARCA',
      });
      if (
        !result.orderId ||
        result.status === 'rejected' ||
        result.status === 'expired'
      ) {
        this.metrics.recordFlattenFailure('market');
        log.error(
          {
            symbol,
            side,
            qty,
            limitPrice,
            status: result.status,
            error: result.error,
            message: result.message,
          },
          'flatten pre limit rejected — position remains open',
        );
        return;
      }
      exitOrderId = result.orderId;
      log.info(
        { symbol, side, qty, limitPrice, exitOrderId },
        'flatten pre limit sent',
      );
    } catch (err) {
      this.metrics.recordFlattenFailure('market');
      log.error(
        { symbol, err: errMsg(err) },
        'placeLimitOrder threw during flatten pre',
      );
      return;
    }

    for (const ctx of ctxsToExit) {
      try {
        await this.tradeRepo.patch(ctx.bracket.entryOrderId, {
          bracket: { forcedExitOrderId: exitOrderId },
        });
        this.metrics.recordFlattenOutcome('marketSent');
      } catch (err) {
        this.metrics.recordFlattenFailure('persist');
        log.warn(
          {
            symbol: ctx.symbol,
            model: ctx.model,
            entryOrderId: ctx.bracket.entryOrderId,
            forcedExitOrderId: exitOrderId,
            err: errMsg(err),
          },
          'failed to persist forcedExitOrderId; pre flatten already sent',
        );
      }
    }
  }

  private async cancelEntry(
    ctx: TradeContext,
    accountId: string,
  ): Promise<void> {
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
        'pre entry cancelled at flatten boundary',
      );
    } catch (err) {
      this.metrics.recordFlattenFailure('cancel');
      log.error(
        { symbol: ctx.symbol, err: errMsg(err) },
        'failed to cancel pre entry',
      );
    }
  }
}
