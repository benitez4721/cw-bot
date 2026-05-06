export interface TradedSymbolsRepository {
  has(symbol: string): Promise<boolean>;
  add(symbol: string): Promise<void>;
}
