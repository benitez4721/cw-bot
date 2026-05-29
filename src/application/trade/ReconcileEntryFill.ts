import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { TradeContext } from '../../domain/trade/TradeTypes.js';
import { logger } from '../../infrastructure/logging/logger.js';
import type { RecordOrderFill } from './RecordOrderFill.js';

const log = logger.child({ component: 'ReconcileEntryFill' });

export interface ReconcileEntryFillDeps {
  broker: BrokerPort;
  recordOrderFill: RecordOrderFill;
}

export interface ReconcileEntryFillInput {
  ctx: TradeContext;
}

// Cierra la race entre el WS de orders y el `tradeRepo.put(ctx)`. Si el fill
// del entry llega al OrderStreamManager antes de que el ctx exista en Redis,
// el manager descarta el evento ("fill event received but no trade context
// found"). Esta reconciliacion corre justo despues del put: consulta al
// broker, y si el entry ya esta `filled`, persiste el fill via
// RecordOrderFill (idempotente — si el WS gano la carrera y ya lo persistio,
// el patch es no-op).
//
// No es fatal si el getOrders falla: patch-missing-fills.ts queda como
// safety net para reconciliacion diferida.
export class ReconcileEntryFill {
  private readonly broker: BrokerPort;
  private readonly recordOrderFill: RecordOrderFill;

  constructor(deps: ReconcileEntryFillDeps) {
    this.broker = deps.broker;
    this.recordOrderFill = deps.recordOrderFill;
  }

  async execute({ ctx }: ReconcileEntryFillInput): Promise<void> {
    if (ctx.entryFillPrice !== undefined) return;
    if (!ctx.accountId) return;

    const entryOrderId = ctx.bracket.entryOrderId;
    try {
      const orders = await this.broker.getOrders({
        symbol: ctx.symbol,
        accountId: ctx.accountId,
      });
      const entry = orders.find((o) => o.id === entryOrderId);
      if (!entry?.filledPrice) return;
      await this.recordOrderFill.execute({ ctx, order: entry });
    } catch (err) {
      log.warn(
        {
          model: ctx.model,
          symbol: ctx.symbol,
          accountId: ctx.accountId,
          entryOrderId,
          err: err instanceof Error ? err.message : String(err),
        },
        'post-put reconcile failed — patch-missing-fills is the safety net',
      );
    }
  }
}
