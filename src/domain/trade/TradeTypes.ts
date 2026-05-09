import type { OrderSide } from '../broker/BrokerTypes.js';
import type { RuleCheck } from '../decision/DecisionTypes.js';

export type TradeContextStatus = 'active' | 'closed';

export interface TradeContext {
  orderId: string;
  symbol: string;
  side: OrderSide;
  entryLimitPrice: number;
  evalStart: string;
  evalEnd: string;
  // Opaque snapshot owned by whichever decision model produced the signal.
  // Persisted as-is for postmortem; not read back by application code.
  indicators: unknown;
  checks: RuleCheck[];
  status: TradeContextStatus;
}
