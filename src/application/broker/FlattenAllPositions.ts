import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type {
  Order,
  OrderSide,
  Position,
} from '../../domain/broker/BrokerTypes.js';
import type { MetricsPort } from '../../domain/metrics/MetricsPort.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../domain/trade/TradeTypes.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { errMsg } from '../../shared/errors.js';
import { sleep } from '../../shared/async.js';
import { groupByAccountAndSymbol, isOrderActive } from './flattenHelpers.js';

const log = logger.child({ component: 'FlattenAllPositions' });

// Tras enviar el DELETE de los exits del bracket, TradeStation puede demorar
// en propagar el cancel a sus chequeos de riesgo. Si mandamos el Market antes
// de que las legs queden en estado terminal, TS rechaza con
// "you are long N shares with N remaining on sell orders". Poleamos getOrders
// hasta confirmar terminal o agotar el timeout.
const DEFAULT_PARAMS = {
  cancelConfirmTimeoutMs: 3000,
  cancelPollIntervalMs: 200,
} as const;

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
//   - Posición abierta → cancela stop+TP del bracket, espera confirmación
//     terminal en getOrders y recién ahí envía un Market opuesto por el qty
//     agregado de la posición. Persiste el OrderID del Market en
//     `forcedExitOrderId` del TradeContext para que el dashboard agrupe el
//     Market con el bracket original (4ta pierna del trade).
//
// Multi-context por (accountId, symbol) → cancela las exits de TODOS los ctxs
// del grupo en un único batch, espera confirmación, y manda un único Market
// con qty agregada. El mismo forcedExitOrderId se propaga a cada context del
// grupo. Dos estrategias en accounts distintos con AAPL se cierran
// independientes porque la position se busca solo en el snapshot del
// accountId del grupo.
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

    // Cada Position trae su `accountId` poblado por el adapter, así que
    // podemos concatenar plano y filtrar por accountId al matchear contra el
    // ctx. Orders se concatenan también: orderId es único cross-account.
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
    const symbol = contexts[0].symbol;
    const position = positions.find(
      (p) =>
        p.accountId === accountId && p.symbol === symbol && p.quantity !== 0,
    );

    // Clasificación por ctx → entry pendiente vs requiere market vs sin nada.
    const ctxsWithEntryPending: TradeContext[] = [];
    const ctxsToFlatten: TradeContext[] = [];
    for (const ctx of contexts) {
      const entryOrder = orders.find((o) => o.id === ctx.bracket.entryOrderId);
      if (entryOrder && isOrderActive(entryOrder.status)) {
        ctxsWithEntryPending.push(ctx);
      } else if (position) {
        ctxsToFlatten.push(ctx);
      } else {
        this.metrics.recordFlattenOutcome('skipped');
        log.info(
          {
            symbol: ctx.symbol,
            model: ctx.model,
            entryOrderId: ctx.bracket.entryOrderId,
          },
          'no entry pending and no position; nothing to do',
        );
      }
    }

    // Caso A — cancela entries pendientes (el OSO BRK cancela sus exits).
    await Promise.allSettled(
      ctxsWithEntryPending.map((ctx) => this.cancelEntry(ctx, accountId)),
    );

    if (ctxsToFlatten.length === 0) return;

    // Caso B — cancela TODAS las exits del grupo en un batch y espera
    // confirmación terminal antes de mandar el Market. Sin la espera, TS
    // rechaza el Market porque ve las exits viejas todavía pendientes en su
    // chequeo de riesgo (mensaje: "N remaining on sell orders").
    const allExitIds = ctxsToFlatten.flatMap((ctx) =>
      [ctx.bracket.stopOrderId, ctx.bracket.takeProfitOrderId].filter(
        (id): id is string => !!id,
      ),
    );
    await Promise.allSettled(
      allExitIds.map((orderId) =>
        this.broker.cancelOrder({ orderId, accountId }),
      ),
    );

    const cancelConfirmed = await this.waitOrdersTerminal(
      allExitIds,
      accountId,
    );
    if (!cancelConfirmed) {
      this.metrics.recordFlattenFailure('cancelTimeout');
      log.error(
        { symbol, accountId, exitIds: allExitIds },
        'bracket exits still active after cancel — skipping Market to avoid TS reject',
      );
      return;
    }

    const side: OrderSide = position!.quantity > 0 ? 'SELL' : 'BUY';
    const qty = Math.abs(position!.quantity);
    let marketOrderId: string;
    try {
      const result = await this.broker.placeMarketOrder({
        symbol,
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
            symbol,
            side,
            qty,
            status: result.status,
            error: result.error,
            message: result.message,
          },
          'placeMarketOrder rejected — position remains open',
        );
        return;
      }
      marketOrderId = result.orderId;
      log.info({ symbol, side, qty, marketOrderId }, 'flatten market sent');
    } catch (err) {
      this.metrics.recordFlattenFailure('market');
      log.error({ symbol, err: errMsg(err) }, 'placeMarketOrder threw');
      return;
    }

    for (const ctx of ctxsToFlatten) {
      try {
        await this.tradeRepo.patch(ctx.bracket.entryOrderId, {
          bracket: { forcedExitOrderId: marketOrderId },
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
        'entry cancelled before close',
      );
    } catch (err) {
      this.metrics.recordFlattenFailure('cancel');
      log.error(
        { symbol: ctx.symbol, err: errMsg(err) },
        'failed to cancel entry',
      );
    }
  }

  private async waitOrdersTerminal(
    orderIds: readonly string[],
    accountId: string,
  ): Promise<boolean> {
    if (orderIds.length === 0) return true;
    const idSet = new Set(orderIds);
    const deadline = Date.now() + DEFAULT_PARAMS.cancelConfirmTimeoutMs;
    while (true) {
      const currentOrders = await this.broker.getOrders({ accountId });
      const stillActive = currentOrders.some(
        (o) => idSet.has(o.id) && isOrderActive(o.status),
      );
      if (!stillActive) return true;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await sleep(Math.min(DEFAULT_PARAMS.cancelPollIntervalMs, remaining));
    }
  }
}
