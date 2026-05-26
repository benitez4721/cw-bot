import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { OrderSide, Quote } from '../../domain/broker/BrokerTypes.js';
import type { Bar } from '../../domain/marketdata/MarketDataTypes.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../domain/trade/TradeTypes.js';
import { logger } from '../../infrastructure/logging/logger.js';
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
//   - Marca syntheticExitFired = true para no re-disparar en el bar siguiente.
//
// Idempotencia: el patch a syntheticExitFired es atomico via WATCH/MULTI del
// repo. La query upstream filtra los ctx ya disparados, asi que si el repo
// confirma el patch, el bar siguiente no los ve.
//
// Riesgo conocido (fill parcial en pre con liquidez fina): si la Limit solo
// llena parcialmente, queda saldo expuesto. La idempotencia simple actual
// asume fill total — Fase 6 / hardening puede mejorar esto chequeando la
// posicion en lugar de marcar al enviar.
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
        !ctx.syntheticExitFired &&
        !!ctx.accountId &&
        ctx.stopPrice !== undefined &&
        ctx.takeProfitPrice !== undefined,
    );
    if (candidates.length === 0) return;

    for (const ctx of candidates) {
      if (!this.shouldTrigger(ctx, bar)) continue;
      await this.fireExit(ctx);
    }
  }

  private shouldTrigger(ctx: TradeContext, bar: Bar): boolean {
    // Validados en execute(); narrow para TS.
    if (ctx.stopPrice === undefined || ctx.takeProfitPrice === undefined) {
      return false;
    }
    // Usamos close (no high/low) para filtrar ruido de prints sueltos del pre,
    // a costa de demorar el exit hasta el cierre del minuto.
    if (ctx.side === 'BUY') {
      return bar.close <= ctx.stopPrice || bar.close >= ctx.takeProfitPrice;
    }
    return bar.close >= ctx.stopPrice || bar.close <= ctx.takeProfitPrice;
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

    const limitPrice = this.crossTheSpread(quote, exitSide);
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
        syntheticExitFired: true,
        bracket: { forcedExitOrderId: orderId },
      });
    } catch (err) {
      log.warn(
        {
          symbol: ctx.symbol,
          entryOrderId: ctx.bracket.entryOrderId,
          forcedExitOrderId: orderId,
          err: errMsg(err),
        },
        'failed to persist syntheticExitFired; exit already sent',
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

  private crossTheSpread(quote: Quote, side: OrderSide): number | undefined {
    const offset = DEFAULT_PARAMS.crossOffsetBps / 10_000;
    const base =
      side === 'SELL' ? (quote.bid ?? quote.last) : (quote.ask ?? quote.last);
    if (!Number.isFinite(base) || base <= 0) return undefined;
    const raw = side === 'SELL' ? base * (1 - offset) : base * (1 + offset);
    return Math.round(raw * 100) / 100;
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
