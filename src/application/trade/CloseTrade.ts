import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';

export class CloseTrade {
  constructor(private readonly repository: TradeContextRepository) {}

  async execute(entryOrderId: string): Promise<void> {
    if (!entryOrderId) throw new Error('entryOrderId is required');
    await this.repository.patch(entryOrderId, { status: 'closed' });
  }
}
