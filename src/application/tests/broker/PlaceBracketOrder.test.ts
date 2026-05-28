import { describe, expect, it, vi } from 'vitest';
import { PlaceBracketOrder } from '../../../application/broker/PlaceBracketOrder.js';
import type { BrokerPort } from '../../../domain/broker/BrokerPort.js';

function makeBroker() {
  return {
    placeBracketOrder: vi.fn(async () => ({
      status: 'open' as const,
      entryOrderId: 'E1',
      stopOrderId: 'S1',
      takeProfitOrderId: 'T1',
    })),
  } as unknown as BrokerPort & {
    placeBracketOrder: ReturnType<typeof vi.fn>;
  };
}

describe('PlaceBracketOrder', () => {
  const base = {
    symbol: 'AAPL',
    quantity: 100,
    side: 'BUY' as const,
    entryLimitPrice: 180,
    stopOffset: 1,
    takeProfitOffset: 2,
    accountId: 'SIM1',
  };

  it('delega al port con el input recibido', async () => {
    const broker = makeBroker();
    const useCase = new PlaceBracketOrder(broker);

    const result = await useCase.execute(base);

    expect(result.entryOrderId).toBe('E1');
    expect(broker.placeBracketOrder).toHaveBeenCalledWith(base);
  });

  it('acepta input sin takeProfitOffset (bracket stop-only)', async () => {
    const broker = makeBroker();
    const useCase = new PlaceBracketOrder(broker);
    const { takeProfitOffset: _tp, ...withoutTp } = base;
    void _tp;

    await useCase.execute(withoutTp);

    expect(broker.placeBracketOrder).toHaveBeenCalledWith(withoutTp);
  });

  it('valida stopOffset > 0', async () => {
    const broker = makeBroker();
    const useCase = new PlaceBracketOrder(broker);
    await expect(useCase.execute({ ...base, stopOffset: 0 })).rejects.toThrow(
      /stopOffset/,
    );
    expect(broker.placeBracketOrder).not.toHaveBeenCalled();
  });

  it('valida takeProfitOffset > 0 cuando esta definido', async () => {
    const broker = makeBroker();
    const useCase = new PlaceBracketOrder(broker);
    await expect(
      useCase.execute({ ...base, takeProfitOffset: 0 }),
    ).rejects.toThrow(/takeProfitOffset/);
    expect(broker.placeBracketOrder).not.toHaveBeenCalled();
  });

  it('valida campos basicos', async () => {
    const broker = makeBroker();
    const useCase = new PlaceBracketOrder(broker);
    await expect(useCase.execute({ ...base, symbol: '' })).rejects.toThrow(
      /symbol/,
    );
    await expect(useCase.execute({ ...base, quantity: 0 })).rejects.toThrow(
      /quantity/,
    );
    await expect(
      useCase.execute({ ...base, entryLimitPrice: -1 }),
    ).rejects.toThrow(/entryLimitPrice/);
  });
});
