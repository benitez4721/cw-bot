import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { IndicatorPort } from '../../domain/indicators/IndicatorPort.js';
import type { Bar } from '../../domain/marketdata/MarketDataTypes.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../domain/trade/TradeTypes.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { bpsToFraction, round2 } from '../../domain/shared/math.js';
import { errMsg } from '../../shared/errors.js';

const log = logger.child({ component: 'MaybeTrailStopAlongEma' });

export interface MaybeTrailStopAlongEmaDeps {
  tradeRepo: TradeContextRepository;
  broker: BrokerPort;
  indicators: IndicatorPort;
}

// Trail por EMA para ctx que nacieron con trailMode 'ema' (EventStrategy
// HighOfDayAlertEmaTrail). El BarStreamManager lo invoca cada barra M1 en
// pre y rth, antes de CheckSyntheticStops.
//
// Por cada ctx activo del symbol con emaTrailPeriod/emaTrailBufferBps y
// entryFillPrice presentes:
//   - Long:  newStop = EMA(period) * (1 - bufferBps/10_000). Si > stopPrice, patch.
//   - Short: newStop = EMA(period) * (1 + bufferBps/10_000). Si < stopPrice, patch.
// Solo sube (long) o baja (short) el stop — nunca lo empeora.
//
// En sesion rth ademas hace broker.replaceStopPrice contra ctx.bracket.stopOrderId
// (el bot toma control del stop; ya no es trailing nativo de TS). En sesion pre
// solo persiste el stop sintetico (no hay StopMarket en el broker).
export class MaybeTrailStopAlongEma {
  private readonly tradeRepo: TradeContextRepository;
  private readonly broker: BrokerPort;
  private readonly indicators: IndicatorPort;

  constructor(deps: MaybeTrailStopAlongEmaDeps) {
    this.tradeRepo = deps.tradeRepo;
    this.broker = deps.broker;
    this.indicators = deps.indicators;
  }

  async execute(symbol: string, _bar: Bar): Promise<void> {
    const active = await this.tradeRepo.listAllActive();
    const candidates = active.filter(
      (ctx) =>
        ctx.symbol === symbol &&
        ctx.emaTrailPeriod !== undefined &&
        ctx.emaTrailBufferBps !== undefined &&
        ctx.entryFillPrice !== undefined &&
        !ctx.syntheticExitFired,
    );
    if (candidates.length === 0) return;

    for (const ctx of candidates) {
      try {
        const ema = await this.indicators.getEMA({
          symbol: ctx.symbol,
          interval: '1min',
          period: ctx.emaTrailPeriod!,
        });
        const candidate = computeStop(
          ctx.side,
          ema.value,
          ctx.emaTrailBufferBps!,
        );
        if (!improvesStop(ctx, candidate)) continue;

        if (ctx.session === 'rth' && ctx.bracket.stopOrderId && ctx.accountId) {
          await this.broker.replaceStopPrice({
            orderId: ctx.bracket.stopOrderId,
            stopPrice: candidate,
            accountId: ctx.accountId,
          });
        }
        await this.tradeRepo.patch(ctx.bracket.entryOrderId, {
          stopPrice: candidate,
        });
        log.info(
          {
            symbol: ctx.symbol,
            session: ctx.session,
            entryOrderId: ctx.bracket.entryOrderId,
            stopOrderId: ctx.bracket.stopOrderId,
            prevStop: ctx.stopPrice,
            newStop: candidate,
            ema: ema.value,
          },
          'stop trailed along EMA',
        );
      } catch (err) {
        log.warn(
          {
            symbol: ctx.symbol,
            entryOrderId: ctx.bracket.entryOrderId,
            err: errMsg(err),
          },
          'failed to trail stop along EMA — will retry next bar',
        );
      }
    }
  }
}

function computeStop(
  side: TradeContext['side'],
  emaValue: number,
  bufferBps: number,
): number {
  const factor = bpsToFraction(bufferBps);
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
