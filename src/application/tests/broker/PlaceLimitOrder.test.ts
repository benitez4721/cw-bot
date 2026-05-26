import { describe, expect, it, vi } from 'vitest';
import { PlaceLimitOrder } from '../../../application/broker/PlaceLimitOrder.js';
import type { BrokerPort } from '../../../domain/broker/BrokerPort.js';
import type { MetricsPort } from '../../../domain/metrics/MetricsPort.js';

function fakes() {
  const broker = {
    placeLimitOrder: vi.fn(async () => ({
      orderId: 'O-1',
      status: 'open' as const,
    })),
  } as unknown as BrokerPort & {
    placeLimitOrder: ReturnType<typeof vi.fn>;
  };
  const metrics = {
    recordOrderResult: vi.fn(),
  } as unknown as MetricsPort & {
    recordOrderResult: ReturnType<typeof vi.fn>;
  };
  return { broker, metrics };
}

describe('PlaceLimitOrder', () => {
  it('delega al port con el input recibido y registra el status', async () => {
    const { broker, metrics } = fakes();
    const useCase = new PlaceLimitOrder(broker, metrics);

    const result = await useCase.execute({
      symbol: 'AAPL',
      quantity: 100,
      side: 'BUY',
      limitPrice: 180,
      accountId: 'SIM1',
      duration: 'DYP',
      route: 'ARCA',
    });

    expect(result.orderId).toBe('O-1');
    expect(broker.placeLimitOrder).toHaveBeenCalledWith({
      symbol: 'AAPL',
      quantity: 100,
      side: 'BUY',
      limitPrice: 180,
      accountId: 'SIM1',
      duration: 'DYP',
      route: 'ARCA',
    });
    expect(metrics.recordOrderResult).toHaveBeenCalledWith('open');
  });

  it('valida campos del input', async () => {
    const { broker, metrics } = fakes();
    const useCase = new PlaceLimitOrder(broker, metrics);
    const base = {
      symbol: 'AAPL',
      quantity: 100,
      side: 'BUY' as const,
      limitPrice: 180,
      accountId: 'SIM1',
      duration: 'DYP' as const,
    };

    await expect(useCase.execute({ ...base, symbol: '' })).rejects.toThrow(
      /symbol/,
    );
    await expect(useCase.execute({ ...base, quantity: 0 })).rejects.toThrow(
      /quantity/,
    );
    await expect(useCase.execute({ ...base, limitPrice: -1 })).rejects.toThrow(
      /limitPrice/,
    );
    await expect(useCase.execute({ ...base, accountId: '' })).rejects.toThrow(
      /accountId/,
    );
    expect(broker.placeLimitOrder).not.toHaveBeenCalled();
  });
});
