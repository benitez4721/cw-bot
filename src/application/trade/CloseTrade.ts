import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';

export class CloseTrade {
  constructor(private readonly repository: TradeContextRepository) {}

  async execute(entryOrderId: string): Promise<void> {
    if (!entryOrderId) throw new Error('entryOrderId is required');

    const ctx = await this.repository.getByOrderId(entryOrderId);
    if (!ctx) return;
    if (ctx.status === 'closed') return;

    await this.repository.put({ ...ctx, status: 'closed' });
  }
}
