import type { TradedSymbolsRepository } from '../../domain/trade/TradedSymbolsRepository.js';

export class InMemoryTradedSymbolsRepository implements TradedSymbolsRepository {
  private readonly symbols = new Set<string>();

  async has(symbol: string): Promise<boolean> {
    return this.symbols.has(symbol);
  }

  async add(symbol: string): Promise<void> {
    this.symbols.add(symbol);
  }
}
