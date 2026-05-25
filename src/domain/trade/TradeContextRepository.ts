import type { TradeContext, TradeContextBracket } from './TradeTypes.js';

export type TradeContextPatch = Omit<Partial<TradeContext>, 'bracket'> & {
  bracket?: Partial<TradeContextBracket>;
};

export interface TradeContextRepository {
  // Crea o reemplaza el ctx entero. Lo usa solo RecordTradeContext en la
  // creación inicial. Mutaciones parciales van por patch().
  put(ctx: TradeContext): Promise<void>;
  // Read-modify-write atómico de los campos provistos. Preserva el resto
  // del ctx (incluyendo campos del bracket no provistos). No-op si la key
  // no existe en Redis.
  patch(entryOrderId: string, partial: TradeContextPatch): Promise<void>;
  getByOrderId(orderId: string): Promise<TradeContext | undefined>;
  getByOrderIds(orderIds: string[]): Promise<Map<string, TradeContext>>;
  listActiveByModel(model: string): Promise<TradeContext[]>;
  // Cross-model / cross-symbol — usado por el flatten pre-close.
  listAllActive(): Promise<TradeContext[]>;
}
