import type { DecisionSignal } from '../../domain/decision/DecisionTypes.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import type {
  TradeContext,
  TradeContextBracket,
} from '../../domain/trade/TradeTypes.js';
import { round2 } from '../../domain/shared/math.js';

type BuySignal = Extract<DecisionSignal<unknown>, { action: 'buy' }>;

interface BaseInput {
  model: string;
  // Account contra el que se envió la orden. Se propaga al TradeContext para
  // que el monitoreo (CheckOpenTrades, flatten, replaceStop, syntheticStops)
  // sepa a qué account ir.
  accountId: string;
  signal: BuySignal;
  evalStart: string;
  evalEnd: string;
}

// Sesion regular: bracket OSO completo (entry Limit + StopMarket + Limit exits).
// stop/TP viven en TradeStation y los gestiona el broker.
export interface RecordRthTradeContextInput extends BaseInput {
  session: 'rth';
  bracket: TradeContextBracket;
}

// Sesion pre-market: solo entry Limit en TS. stop/TP se derivan del signal y se
// persisten en el TradeContext para que CheckSyntheticStops los lea.
export interface RecordPreTradeContextInput extends BaseInput {
  session: 'pre';
  entryOrderId: string;
}

export type RecordTradeContextInput =
  | RecordRthTradeContextInput
  | RecordPreTradeContextInput;

export class RecordTradeContext {
  constructor(private readonly repository: TradeContextRepository) {}

  async execute(input: RecordTradeContextInput): Promise<TradeContext> {
    if (!input.model) throw new Error('model is required');

    const ctx = input.session === 'rth' ? buildRth(input) : buildPre(input);
    await this.repository.put(ctx);
    return ctx;
  }
}

function buildRth(input: RecordRthTradeContextInput): TradeContext {
  if (!input.bracket.entryOrderId)
    throw new Error('bracket.entryOrderId is required');

  const { model, accountId, bracket, signal, evalStart, evalEnd } = input;
  return {
    model,
    accountId,
    symbol: signal.symbol,
    side: signal.side,
    entryLimitPrice: signal.entryLimitPrice,
    evalStart,
    evalEnd,
    bracket,
    indicators: signal.snapshot,
    checks: signal.checks,
    status: 'active',
    session: 'rth',
  };
}

function buildPre(input: RecordPreTradeContextInput): TradeContext {
  if (!input.entryOrderId) throw new Error('entryOrderId is required');

  const { model, accountId, entryOrderId, signal, evalStart, evalEnd } = input;
  // Misma formula que TradeStationBrokerAdapter.placeBracketOrder: stop/TP se
  // calculan con entryLimitPrice como proxy del fill. Si el fill es mejor,
  // los offsets terminan asimetricos en cents — aceptado para v1.
  const stopPrice =
    signal.side === 'BUY'
      ? round2(signal.entryLimitPrice - signal.stopOffset)
      : round2(signal.entryLimitPrice + signal.stopOffset);
  const takeProfitPrice =
    signal.side === 'BUY'
      ? round2(signal.entryLimitPrice + signal.takeProfitOffset)
      : round2(signal.entryLimitPrice - signal.takeProfitOffset);

  return {
    model,
    accountId,
    symbol: signal.symbol,
    side: signal.side,
    entryLimitPrice: signal.entryLimitPrice,
    stopPrice,
    takeProfitPrice,
    evalStart,
    evalEnd,
    bracket: { entryOrderId },
    indicators: signal.snapshot,
    checks: signal.checks,
    status: 'active',
    session: 'pre',
  };
}
