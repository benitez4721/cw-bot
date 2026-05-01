export type WatchedSymbolStatus = 'active' | 'stale';

export interface WatchedSymbol {
  symbol: string;
  status: WatchedSymbolStatus;
  createdAt: number;
}
