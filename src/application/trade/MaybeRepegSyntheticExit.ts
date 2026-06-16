import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { OrderSide, Quote } from '../../domain/broker/BrokerTypes.js';
import type { Bar } from '../../domain/marketdata/MarketDataTypes.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../domain/trade/TradeTypes.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { errMsg } from '../../shared/errors.js';
import {
  crossTheSpread,
  waitOrdersTerminal,
} from '../broker/flattenHelpers.js';
import type { PlaceLimitOrder } from '../broker/PlaceLimitOrder.js';

const log = logger.child({ component: 'MaybeRepegSyntheticExit' });

const DEFAULT_PARAMS = {
  crossOffsetBps: 5,
  cancelConfirmTimeoutMs: 3000,
  cancelPollIntervalMs: 200,
} as const;

export interface MaybeRepegSyntheticExitDeps {
  broker: BrokerPort;
  tradeRepo: TradeContextRepository;
  placeLimitOrder: PlaceLimitOrder;
}

// Persecucion del Limit de salida sintetico en sesion pre (trailing porcentual).
//
// Una vez que CheckSyntheticStops disparo el exit (hay forcedExitOrderId), el
// trade ya esta "comprometido a salir". Este use case mantiene ese Limit pegado
// al mercado: cada barra M1 recalcula el cross-the-spread del precio actual y, si
// difiere del Limit vigente (el precio se movio, suba o baje), cancela el viejo y
// recoloca uno nuevo por la cantidad del ctx (entryFillQuantity). Asi el exit no
// queda colgado por encima de un mercado que cae, ni se pierde una mejor salida
// si el precio sube.
//
// El BarStreamManager lo invoca en cada bar 1m durante pre, DESPUES de
// CheckSyntheticStops (que arma el exit en ese mismo bar). Filtra por ctx con
// forcedExitOrderId presente — es el conjunto complementario a CheckSyntheticStops
// (que solo mira los aun no disparados).
//
// El cierre del ctx NO lo maneja este use case: cuando el Limit llena,
// RecordOrderFill (via OrderStream) marca el ctx closed y deja de ser candidato.
// Fuente de verdad por-ctx: la orden de salida propia (orderId), no la posicion
// agregada del broker (que no distingue ctx cuando dos estrategias comparten
// symbol+cuenta). Se recoloca por entryFillQuantity asumiendo fill total; un
// residuo parcial (raro con Limit marketable) lo barre el flatten 9:20.
export class MaybeRepegSyntheticExit {
  private readonly broker: BrokerPort;
  private readonly tradeRepo: TradeContextRepository;
  private readonly placeLimitOrder: PlaceLimitOrder;

  constructor(deps: MaybeRepegSyntheticExitDeps) {
    this.broker = deps.broker;
    this.tradeRepo = deps.tradeRepo;
    this.placeLimitOrder = deps.placeLimitOrder;
  }

  async execute(symbol: string, _bar: Bar): Promise<void> {
    const active = await this.tradeRepo.listAllActive();
    const candidates = active.filter(
      (ctx) =>
        ctx.symbol === symbol &&
        ctx.session === 'pre' &&
        ctx.bracket.forcedExitOrderId !== undefined &&
        ctx.trailingStopPercent !== undefined &&
        !!ctx.accountId &&
        ctx.entryFillQuantity !== undefined &&
        ctx.entryFillQuantity > 0,
    );
    if (candidates.length === 0) return;

    for (const ctx of candidates) {
      try {
        await this.repeg(ctx);
      } catch (err) {
        log.warn(
          {
            symbol: ctx.symbol,
            entryOrderId: ctx.bracket.entryOrderId,
            err: errMsg(err),
          },
          'repeg threw — will retry next bar',
        );
      }
    }
  }

  private async repeg(ctx: TradeContext): Promise<void> {
    const accountId = ctx.accountId!;
    const oldOrderId = ctx.bracket.forcedExitOrderId!;
    const quantity = ctx.entryFillQuantity!;
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
        'getQuote threw — skipping repeg this bar',
      );
      return;
    }

    const newPrice = crossTheSpread(
      quote,
      exitSide,
      DEFAULT_PARAMS.crossOffsetBps,
    );
    if (newPrice === undefined) {
      log.warn(
        { symbol: ctx.symbol, quote },
        'quote has no usable price — skipping repeg this bar',
      );
      return;
    }

    // El precio no se movio respecto al Limit vigente: nada que recolocar.
    if (newPrice === ctx.bracket.forcedExitLimitPrice) return;

    // Cancelar el Limit viejo y confirmar terminal ANTES de recolocar: evita dos
    // Limits vivos (doble fill). Si el cancel no confirma a tiempo, no recolocamos
    // este bar y reintentamos en el siguiente.
    await this.broker.cancelOrder({ orderId: oldOrderId, accountId });
    const terminal = await waitOrdersTerminal(
      this.broker,
      [oldOrderId],
      accountId,
      {
        timeoutMs: DEFAULT_PARAMS.cancelConfirmTimeoutMs,
        pollMs: DEFAULT_PARAMS.cancelPollIntervalMs,
      },
    );
    if (!terminal) {
      log.warn(
        { symbol: ctx.symbol, oldOrderId },
        'cancel not confirmed terminal — skipping repeg this bar',
      );
      return;
    }

    const result = await this.placeLimitOrder.execute({
      symbol: ctx.symbol,
      quantity,
      side: exitSide,
      limitPrice: newPrice,
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
        'repeg limit rejected — will retry next bar',
      );
      return;
    }
    const newOrderId = result.orderId;

    await this.tradeRepo.patch(ctx.bracket.entryOrderId, {
      bracket: {
        forcedExitOrderId: newOrderId,
        forcedExitLimitPrice: newPrice,
      },
    });

    log.info(
      {
        symbol: ctx.symbol,
        entryOrderId: ctx.bracket.entryOrderId,
        oldOrderId,
        newOrderId,
        side: exitSide,
        prevLimit: ctx.bracket.forcedExitLimitPrice,
        newLimit: newPrice,
      },
      'synthetic exit limit re-pegged',
    );
  }
}
