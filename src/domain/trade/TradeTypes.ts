import type { OrderSide } from '../broker/BrokerTypes.js';
import type { RuleCheck } from '../decision/DecisionTypes.js';

export type TradeContextStatus = 'active' | 'closed';

// Sesion en la que se abrio el trade.
// - 'rth': bracket OSO clasico (entry Limit + StopMarket + Limit exits en TS).
// - 'pre': solo entry Limit en TS; stop/TP son sinteticos, gestionados por el
//   bot via CheckSyntheticStops y FlattenPrePositions.
// Opcional solo por compat con contexts persistidos antes del refactor pre-market.
export type TradeContextSession = 'pre' | 'rth';

export interface TradeContextBracket {
  entryOrderId: string;
  // Opcional para soportar sesion pre, donde no hay StopMarket en el broker —
  // el stop se gestiona sinteticamente desde el bot.
  stopOrderId?: string;
  takeProfitOrderId?: string;
  // OrderID of the Market order used to flatten this trade pre-close.
  // Indexed in the trade repo alongside entryOrderId so the order stream
  // can enrich the Market event with this context, keeping the trade grouped.
  forcedExitOrderId?: string;
}

export interface TradeContext {
  model: string;
  // TradeStation account contra el que se enviaron las órdenes. Opcional sólo
  // por compat con contexts persistidos antes del refactor multi-account; los
  // contexts nuevos siempre lo traen (lo declara la strategy). Los consumers
  // skipean los ctx sin accountId — no se puede resolver broker sin él.
  accountId?: string;
  symbol: string;
  side: OrderSide;
  entryLimitPrice: number;
  // Precios objetivo para el exit. En sesion rth viven en stopOrderId /
  // takeProfitOrderId del broker; en sesion pre se persisten aca porque no
  // hay ordenes en TS que los representen, y CheckSyntheticStops los lee
  // para decidir cuando disparar el exit Limit cross-the-spread.
  stopPrice?: number;
  takeProfitPrice?: number;
  evalStart: string;
  evalEnd: string;
  bracket: TradeContextBracket;
  session?: TradeContextSession;
  // True una vez que el bot mando un exit sintetico (trigger de stop/TP o
  // flatten 9:20). Idempotencia entre bars de pre + entre CheckSyntheticStops
  // y FlattenPrePositions. Solo se setea en sesion pre.
  syntheticExitFired?: boolean;
  // Solo se setea en sesion pre cuando el trade nacio con trailing
  // (EventStrategy). MaybeTrailSyntheticStop sube el stopPrice bar-a-bar
  // siguiendo el high-watermark. Si esta ausente, el stopPrice es fijo
  // (DecisionStrategy pre).
  trailingStopPercent?: number;
  // Trail por EMA (pre + rth): MaybeTrailStopAlongEma calcula
  // `EMA(period) * (1 - bufferBps/10_000)` cada cierre de barra M1 y
  // ajusta el stopPrice (long: solo sube). En rth ademas hace replaceStopPrice
  // contra el stopOrderId del broker; en pre solo persiste el stop sintetico.
  // Mutuamente exclusivo con trailingStopPercent — la strategy decide cual poblar.
  emaTrailPeriod?: number;
  emaTrailBufferBps?: number;
  // Opaque snapshot owned by whichever decision model produced the signal.
  // Persisted as-is for postmortem; not read back by application code.
  indicators: unknown;
  checks: RuleCheck[];
  status: TradeContextStatus;
  // Set true once the trail has moved the stop to entry (one-shot per trade).
  breakEvenMoved?: boolean;
  // Real fills capturados desde el OrderStreamPort. Opcionales porque (a) los
  // contexts previos a este campo no los tienen y (b) un trade abierto puede
  // tener entry lleno sin exit todavia.
  entryFillPrice?: number;
  entryFillQuantity?: number;
  exitFillPrice?: number;
  exitFillQuantity?: number;
  exitLeg?: 'stop' | 'takeProfit' | 'forced';
}
