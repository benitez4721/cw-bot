import type { Bar } from '../../domain/marketdata/MarketDataTypes.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../domain/trade/TradeTypes.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { round2 } from '../../domain/shared/math.js';
import { errMsg } from '../../shared/errors.js';

const log = logger.child({ component: 'MaybeTrailSyntheticStop' });

export interface MaybeTrailSyntheticStopDeps {
  tradeRepo: TradeContextRepository;
}

// Trailing stop sintetico para posiciones abiertas en sesion pre.
//
// El BarStreamManager lo invoca en cada bar 1m durante pre, ANTES de
// CheckSyntheticStops, para que el cross-check use el stopPrice ya
// actualizado del mismo bar.
//
// Por cada TradeContext pre activo con trailingStopPercent definido y
// entryFillPrice presente (ya hay posicion en el broker):
//   - Long:  newStop = bar.high * (1 - tsp/100). Si > stopPrice, patch.
//   - Short: newStop = bar.low  * (1 + tsp/100). Si < stopPrice, patch.
// Solo sube (long) o baja (short) el stop — nunca lo empeora.
//
// Se usa bar.high/bar.low (no close) para capturar el peak intra-minuto.
// CheckSyntheticStops sigue usando bar.close para el cross-check, por
// consistencia con su comportamiento actual (filtrar wicks).
export class MaybeTrailSyntheticStop {
  private readonly tradeRepo: TradeContextRepository;

  constructor(deps: MaybeTrailSyntheticStopDeps) {
    this.tradeRepo = deps.tradeRepo;
  }

  async execute(symbol: string, bar: Bar): Promise<void> {
    const active = await this.tradeRepo.listAllActive();
    const candidates = active.filter(
      (ctx) =>
        ctx.symbol === symbol &&
        ctx.session === 'pre' &&
        ctx.bracket.forcedExitOrderId === undefined &&
        ctx.trailingStopPercent !== undefined &&
        ctx.stopPrice !== undefined &&
        ctx.entryFillPrice !== undefined,
    );
    if (candidates.length === 0) return;

    for (const ctx of candidates) {
      const newStop = this.computeNewStop(ctx, bar);
      if (newStop === undefined) continue;
      try {
        await this.tradeRepo.patch(ctx.bracket.entryOrderId, {
          stopPrice: newStop,
        });
        log.info(
          {
            symbol: ctx.symbol,
            entryOrderId: ctx.bracket.entryOrderId,
            prevStop: ctx.stopPrice,
            newStop,
          },
          'synthetic stop trailed',
        );
      } catch (err) {
        log.warn(
          {
            symbol: ctx.symbol,
            entryOrderId: ctx.bracket.entryOrderId,
            newStop,
            err: errMsg(err),
          },
          'failed to persist trailed stopPrice; will retry next bar',
        );
      }
    }
  }

  private computeNewStop(ctx: TradeContext, bar: Bar): number | undefined {
    // Validado en execute(); narrow para TS.
    if (ctx.trailingStopPercent === undefined || ctx.stopPrice === undefined) {
      return undefined;
    }
    const offset = ctx.trailingStopPercent / 100;
    if (ctx.side === 'BUY') {
      const candidate = round2(bar.high * (1 - offset));
      return candidate > ctx.stopPrice ? candidate : undefined;
    }
    const candidate = round2(bar.low * (1 + offset));
    return candidate < ctx.stopPrice ? candidate : undefined;
  }
}
