import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { IndicatorPort } from '../../domain/indicators/IndicatorPort.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../domain/trade/TradeTypes.js';
import { logger } from '../../infrastructure/logging/logger.js';

const log = logger.child({ component: 'SetInitialStopFromEma' });

export interface SetInitialStopFromEmaInput {
  entryOrderId: string;
}

export interface SetInitialStopFromEmaDeps {
  tradeRepo: TradeContextRepository;
  broker: BrokerPort;
  indicators: IndicatorPort;
}

// Hook post entry-fill para ctx con trail EMA en sesion rth: recalcula la
// EMA con la barra del momento del fill y mueve el StopMarket del broker a
// `EMA(period) * (1 - bufferBps / 10_000)` via replaceStopPrice.
//
// Lo invoca el OrderStreamManager despues de RecordOrderFill cuando la
// order rellenada es la entry. Idempotente: si algo falla, MaybeTrailStopAlongEma
// reintenta en la proxima barra M1. En sesion pre no hay StopMarket en el
// broker (el stop es sintetico), por lo que el use case retorna early.
export class SetInitialStopFromEma {
  private readonly tradeRepo: TradeContextRepository;
  private readonly broker: BrokerPort;
  private readonly indicators: IndicatorPort;

  constructor(deps: SetInitialStopFromEmaDeps) {
    this.tradeRepo = deps.tradeRepo;
    this.broker = deps.broker;
    this.indicators = deps.indicators;
  }

  async execute({ entryOrderId }: SetInitialStopFromEmaInput): Promise<void> {
    const ctx = await this.tradeRepo.getByOrderId(entryOrderId);
    if (!ctx) return;
    if (ctx.emaTrailPeriod === undefined) return;
    if (ctx.emaTrailBufferBps === undefined) return;
    if (ctx.session !== 'rth') return;
    if (!ctx.bracket.stopOrderId) return;
    if (!ctx.accountId) return;

    try {
      const ema = await this.indicators.getEMA({
        symbol: ctx.symbol,
        interval: '1min',
        period: ctx.emaTrailPeriod,
      });
      const newStop = computeStop(ctx.side, ema.value, ctx.emaTrailBufferBps);
      if (!improvesStop(ctx, newStop)) return;

      await this.broker.replaceStopPrice({
        orderId: ctx.bracket.stopOrderId,
        stopPrice: newStop,
        accountId: ctx.accountId,
      });
      await this.tradeRepo.patch(entryOrderId, { stopPrice: newStop });
      log.info(
        {
          symbol: ctx.symbol,
          entryOrderId,
          stopOrderId: ctx.bracket.stopOrderId,
          prevStop: ctx.stopPrice,
          newStop,
          ema: ema.value,
        },
        'initial stop moved to EMA-based level',
      );
    } catch (err) {
      log.warn(
        {
          symbol: ctx.symbol,
          entryOrderId,
          err: errMsg(err),
        },
        'failed to set initial stop from EMA — will retry next bar',
      );
    }
  }
}

function computeStop(
  side: TradeContext['side'],
  emaValue: number,
  bufferBps: number,
): number {
  const factor = bufferBps / 10_000;
  const raw =
    side === 'BUY' ? emaValue * (1 - factor) : emaValue * (1 + factor);
  return round2(raw);
}

function improvesStop(ctx: TradeContext, candidate: number): boolean {
  if (ctx.stopPrice === undefined) return true;
  return ctx.side === 'BUY'
    ? candidate > ctx.stopPrice
    : candidate < ctx.stopPrice;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
