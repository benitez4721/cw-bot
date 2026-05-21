import type { WatchlistRepository } from '../watchlist/WatchlistRepository.js';
import type { DecisionModel } from './DecisionModel.js';

// Cohesive bundle of the pieces needed to run one decision model end-to-end.
// Each strategy owns its own watchlist (separate Redis keyspace); the
// BarStreamManager iterates over the array of strategies on every bar close
// and invokes `model.buildSnapshot` + `model.evaluate` directly. The signal
// emitted by `evaluate` carries quantity/offsets — each model decides how to
// size its order.
export interface DecisionStrategy {
  readonly name: string;
  readonly model: DecisionModel;
  readonly watchlist: WatchlistRepository;
  // Opt-in trail: when defined, BarStreamManager moves the stop to entry as
  // soon as the position reaches this fraction of profit (e.g. 0.005 = 0.5%).
  // Strategies that omit this field keep their bracket untouched after entry.
  readonly trailToBreakEvenAtProfit?: number;
  // TradeStation account contra el que esta estrategia opera. Cada estrategia
  // lo declara explícitamente — no hay default implícito a nivel sistema.
  readonly accountId: string;
}
