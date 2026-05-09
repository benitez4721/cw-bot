import type { OrderSide } from '../broker/BrokerTypes.js';
import type { RuleCheck } from '../decision/DecisionTypes.js';

export type TradeContextStatus = 'active' | 'closed';

export interface TradeContextBracket {
  entryOrderId: string;
  stopOrderId: string;
  takeProfitOrderId: string;
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
}
