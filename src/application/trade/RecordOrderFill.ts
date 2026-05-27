import type { Order } from '../../domain/broker/BrokerTypes.js';
import type {
  TradeContextPatch,
  TradeContextRepository,
} from '../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../domain/trade/TradeTypes.js';

export interface RecordOrderFillInput {
  ctx: TradeContext;
  order: Order;
}

type Leg = 'entry' | 'stop' | 'takeProfit' | 'forced';

export class RecordOrderFill {
  constructor(private readonly repository: TradeContextRepository) {}

  async execute({ ctx, order }: RecordOrderFillInput): Promise<void> {
    if (order.filledPrice == null) return;

    const leg = classifyLeg(ctx, order.id);
    if (!leg) return;

    const patch = buildPatch(leg, order, ctx);
    if (!patch) return;

    await this.repository.patch(ctx.bracket.entryOrderId, patch);
  }
}

function classifyLeg(ctx: TradeContext, orderId: string): Leg | undefined {
  const { entryOrderId, stopOrderId, takeProfitOrderId, forcedExitOrderId } =
    ctx.bracket;
  if (orderId === entryOrderId) return 'entry';
  if (orderId === stopOrderId) return 'stop';
  if (takeProfitOrderId && orderId === takeProfitOrderId) return 'takeProfit';
  if (forcedExitOrderId && orderId === forcedExitOrderId) return 'forced';
  return undefined;
}

function buildPatch(
  leg: Leg,
  order: Order,
  ctx: TradeContext,
): TradeContextPatch | undefined {
  const price = order.filledPrice;
  const qty = order.filledQuantity;

  if (leg === 'entry') {
    if (ctx.entryFillPrice === price && ctx.entryFillQuantity === qty) {
      return undefined;
    }
    return { entryFillPrice: price, entryFillQuantity: qty };
  }

  const exitLeg = exitLegOf(leg);

  if (
    ctx.exitFillPrice === price &&
    ctx.exitFillQuantity === qty &&
    ctx.exitLeg === exitLeg
  ) {
    return undefined;
  }
  return {
    exitFillPrice: price,
    exitFillQuantity: qty,
    exitLeg,
    status: 'closed',
  };
}

function exitLegOf(
  leg: Exclude<Leg, 'entry'>,
): NonNullable<TradeContext['exitLeg']> {
  if (leg === 'stop') return 'stop';
  if (leg === 'takeProfit') return 'takeProfit';
  return 'forced';
}
