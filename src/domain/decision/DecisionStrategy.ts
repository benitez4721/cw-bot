import type { WatchlistRepository } from '../watchlist/WatchlistRepository.js';
import type { DecisionModelPort } from './DecisionPort.js';
import type { OrderConfig } from './DecisionTypes.js';

// Cohesive bundle of the pieces needed to run one decision model end-to-end.
// Each strategy owns its own watchlist (separate Redis keyspace) and its own
// order config; the BarStreamManager iterates over the array of strategies on
// every bar close and invokes `model.buildSnapshot` + `model.evaluate` directly.
export interface DecisionStrategy {
  readonly name: string;
  readonly model: DecisionModelPort;
  readonly watchlist: WatchlistRepository;
  readonly orderConfig: OrderConfig;
  // Opt-in trail: when defined, BarStreamManager moves the stop to entry as
  // soon as the position reaches this fraction of profit (e.g. 0.005 = 0.5%).
  // Strategies that omit this field keep their bracket untouched after entry.
  readonly trailToBreakEvenAtProfit?: number;
}
