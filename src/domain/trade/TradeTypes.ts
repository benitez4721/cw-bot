import type { OrderSide } from '../broker/BrokerTypes.js';
import type { RuleCheck } from '../decision/DecisionTypes.js';

export type TradeContextStatus = 'active' | 'closed';

export interface TradeContextBracket {
  entryOrderId: string;
  stopOrderId: string;
  takeProfitOrderId?: string;
  // OrderID of the Market order used to flatten this trade pre-close.
  // Indexed in the trade repo alongside entryOrderId so the order stream
  // can enrich the Market event with this context, keeping the trade grouped.
  forcedExitOrderId?: string;
}

export interface TradeContext {
  model: string;
  symbol: string;
  side: OrderSide;
  entryLimitPrice: number;
  evalStart: string;
  evalEnd: string;
  bracket: TradeContextBracket;
  // Opaque snapshot owned by whichever decision model produced the signal.
  // Persisted as-is for postmortem; not read back by application code.
  indicators: unknown;
  checks: RuleCheck[];
  status: TradeContextStatus;
  // Set true once the trail has moved the stop to entry (one-shot per trade).
  breakEvenMoved?: boolean;
}
