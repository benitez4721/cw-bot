import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { OrderSide, Quote } from '../../domain/broker/BrokerTypes.js';
import type { Bar } from '../../domain/marketdata/MarketDataTypes.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../domain/trade/TradeTypes.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { errMsg } from '../../shared/errors.js';
import { crossTheSpread } from '../broker/flattenHelpers.js';
import type { PlaceLimitOrder } from '../broker/PlaceLimitOrder.js';

const log = logger.child({ component: 'CheckSyntheticStops' });

// Offset cross-the-spread para que el Limit fillee rapido en pre, donde el
// spread es ancho. Al vender (exit long) cruzamos por debajo del bid; al
// comprar para cubrir (exit short), por encima del ask.
const DEFAULT_PARAMS = {
  crossOffsetBps: 5,
} as const;

export interface CheckSyntheticStopsDeps {
  broker: BrokerPort;
  tradeRepo: TradeContextRepository;
  placeLimitOrder: PlaceLimitOrder;
}

// Monitor de stop/TP sinteticos para posiciones abiertas en sesion pre.
//
// El BarStreamManager lo invoca en cada bar 1m durante pre, dentro del branch
// pre de processSymbol. Por cada TradeContext pre abierto del symbol:
//   - Si bar.close cruza stopPrice (long: <=, short: >=) o takeProfitPrice
//     (long: >=, short: <=), manda un Limit cross-the-spread con
//     duration: 'DYP', lado opuesto y cantidad de la entry.
//   - Persiste forcedExitOrderId + forcedExitLimitPrice; eso marca el ctx como
//     "exit disparado" para no re-disparar (el filtro de arriba pide
//     forcedExitOrderId === undefined).
//
// Idempotencia: el patch es atomico via WATCH/MULTI del repo. La query upstream
// filtra los ctx que ya tienen forcedExitOrderId, asi que si el repo confirma
// el patch, el bar siguiente no los ve aca — pasan a manos de
// MaybeRepegSyntheticExit, que persigue el Limit hasta que llene.
//
// Riesgo conocido (fill parcial en pre con liquidez fina): si la Limit solo
// llena parcialmente, queda saldo expuesto. Asumimos fill total; el residuo lo
// barre el flatten 9:20.
export class CheckSyntheticStops {
  private readonly broker: BrokerPort;
  private readonly tradeRepo: TradeContextRepository;
  private readonly placeLimitOrder: PlaceLimitOrder;

  constructor(deps: CheckSyntheticStopsDeps) {
    this.broker = deps.broker;
    this.tradeRepo = deps.tradeRepo;
    this.placeLimitOrder = deps.placeLimitOrder;
  }

  async execute(symbol: string, bar: Bar): Promise<void> {
    const active = await this.tradeRepo.listAllActive();
    const candidates = active.filter(
      (ctx) =>
        ctx.symbol === symbol &&
        ctx.session === 'pre' &&
        ctx.bracket.forcedExitOrderId === undefined &&
        !!ctx.accountId &&
        ctx.stopPrice !== undefined,
    );
    if (candidates.length === 0) return;

    for (const ctx of candidates) {
      if (!this.shouldTrigger(ctx, bar)) continue;
      await this.fireExit(ctx);
    }
  }

  private shouldTrigger(ctx: TradeContext, bar: Bar): boolean {
    // Validado en execute(); narrow para TS.
    if (ctx.stopPrice === undefined) return false;
    // Usamos close (no high/low) para filtrar ruido de prints sueltos del pre,
    // a costa de demorar el exit hasta el cierre del minuto.
    if (ctx.side === 'BUY') {
      if (bar.close <= ctx.stopPrice) return true;
      return (
        ctx.takeProfitPrice !== undefined && bar.close >= ctx.takeProfitPrice
      );
    }
    if (bar.close >= ctx.stopPrice) return true;
    return (
      ctx.takeProfitPrice !== undefined && bar.close <= ctx.takeProfitPrice
    );
  }

  private async fireExit(ctx: TradeContext): Promise<void> {
    const accountId = ctx.accountId!;
    const exitSide: OrderSide = ctx.side === 'BUY' ? 'SELL' : 'BUY';
    let quote: Quote;
    try {
      quote = await this.broker.getQuote({ symbol: ctx.symbol, accountId });
    } catch (err) {
      log.warn(
        {
          symbol: ctx.symbol,
          entryOrderId: ctx.bracket.entryOrderId,
          err: errMsg(err),
        },
        'getQuote threw — skipping synthetic exit this bar',
      );
      return;
    }

    const limitPrice = crossTheSpread(
      quote,
      exitSide,
      DEFAULT_PARAMS.crossOffsetBps,
    );
    if (limitPrice === undefined) {
      log.warn(
        { symbol: ctx.symbol, quote },
        'quote has no usable price — skipping synthetic exit this bar',
      );
      return;
    }

    // Cantidad: solo gestionamos exits sobre fills confirmados por el
    // OrderStreamPort. Si el entry todavia no llena, no hay posicion que cerrar.
    const quantity = ctx.entryFillQuantity;
    if (!quantity || quantity <= 0) {
      log.info(
        { symbol: ctx.symbol, entryOrderId: ctx.bracket.entryOrderId },
        'no entry fill yet — skipping synthetic exit',
      );
      return;
    }

    let orderId: string | undefined;
    try {
      const result = await this.placeLimitOrder.execute({
        symbol: ctx.symbol,
        quantity,
        side: exitSide,
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
        log.warn(
          {
            symbol: ctx.symbol,
            entryOrderId: ctx.bracket.entryOrderId,
            status: result.status,
            error: result.error,
            message: result.message,
          },
          'synthetic exit rejected — will retry next bar',
        );
        return;
      }
      orderId = result.orderId;
    } catch (err) {
      log.warn(
        {
          symbol: ctx.symbol,
          entryOrderId: ctx.bracket.entryOrderId,
          err: errMsg(err),
        },
        'placeLimitOrder threw — will retry next bar',
      );
      return;
    }

    try {
      await this.tradeRepo.patch(ctx.bracket.entryOrderId, {
        bracket: {
          forcedExitOrderId: orderId,
          forcedExitLimitPrice: limitPrice,
        },
      });
    } catch (err) {
      log.warn(
        {
          symbol: ctx.symbol,
          entryOrderId: ctx.bracket.entryOrderId,
          forcedExitOrderId: orderId,
          err: errMsg(err),
        },
        'failed to persist forcedExitOrderId; exit already sent',
      );
      return;
    }

    log.info(
      {
        symbol: ctx.symbol,
        entryOrderId: ctx.bracket.entryOrderId,
        exitOrderId: orderId,
        side: exitSide,
        limitPrice,
      },
      'synthetic exit fired in pre',
    );
  }
}
