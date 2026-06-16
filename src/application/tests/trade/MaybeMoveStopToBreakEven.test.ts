import { describe, expect, it, vi } from 'vitest';
import { MaybeMoveStopToBreakEven } from '../../../application/trade/MaybeMoveStopToBreakEven.js';
import type { BrokerPort } from '../../../domain/broker/BrokerPort.js';
import type { TradeContextRepository } from '../../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../../domain/trade/TradeTypes.js';

function fakes(contexts: TradeContext[]): {
  broker: BrokerPort & { replaceStopPrice: ReturnType<typeof vi.fn> };
  tradeRepo: TradeContextRepository & {
    patch: ReturnType<typeof vi.fn>;
    listActiveByModel: ReturnType<typeof vi.fn>;
  };
} {
  const broker = {
    replaceStopPrice: vi.fn(async () => undefined),
  } as unknown as BrokerPort & {
    replaceStopPrice: ReturnType<typeof vi.fn>;
  };
  const tradeRepo = {
    listActiveByModel: vi.fn(async () => contexts),
    patch: vi.fn(async () => undefined),
    put: vi.fn(),
    getByOrderId: vi.fn(),
    getByOrderIds: vi.fn(async () => new Map()),
    listAllActive: vi.fn(async () => contexts),
  } as unknown as TradeContextRepository & {
    patch: ReturnType<typeof vi.fn>;
    listActiveByModel: ReturnType<typeof vi.fn>;
  };
  return { broker, tradeRepo };
}

function rthContext(overrides: Partial<TradeContext> = {}): TradeContext {
  return {
    model: 'macd',
    accountId: 'SIM1',
    symbol: 'AAPL',
    side: 'BUY',
    entryLimitPrice: 180,
    evalStart: 's',
    evalEnd: 'e',
    bracket: {
      entryOrderId: 'E1',
      stopOrderId: 'S1',
      takeProfitOrderId: 'T1',
    },
    indicators: {},
    checks: [],
    status: 'active',
    session: 'rth',
    ...overrides,
  };
}

function preContext(overrides: Partial<TradeContext> = {}): TradeContext {
  return {
    model: 'macd',
    accountId: 'SIM1',
    symbol: 'AAPL',
    side: 'BUY',
    entryLimitPrice: 180,
    stopPrice: 179,
    takeProfitPrice: 182,
    evalStart: 's',
    evalEnd: 'e',
    // Sesion pre: solo entryOrderId, sin stopOrderId.
    bracket: { entryOrderId: 'E1' },
    indicators: {},
    checks: [],
    status: 'active',
    session: 'pre',
    ...overrides,
  };
}

describe('MaybeMoveStopToBreakEven', () => {
  it('mueve el stop a break-even en sesion rth cuando profitPct >= threshold', async () => {
    const ctx = rthContext({ entryLimitPrice: 100 });
    const { broker, tradeRepo } = fakes([ctx]);
    const useCase = new MaybeMoveStopToBreakEven({ broker, tradeRepo });

    await useCase.execute({
      model: 'macd',
      symbol: 'AAPL',
      lastPrice: 102, // +2% profit
      threshold: 0.01,
    });

    expect(broker.replaceStopPrice).toHaveBeenCalledWith({
      orderId: 'S1',
      stopPrice: 100,
      accountId: 'SIM1',
    });
    expect(tradeRepo.patch).toHaveBeenCalledWith('E1', {
      breakEvenMoved: true,
    });
  });

  it('skipea contexts pre — no hay stop real en el broker', async () => {
    const ctx = preContext({ entryLimitPrice: 100 });
    const { broker, tradeRepo } = fakes([ctx]);
    const useCase = new MaybeMoveStopToBreakEven({ broker, tradeRepo });

    await useCase.execute({
      model: 'macd',
      symbol: 'AAPL',
      lastPrice: 102,
      threshold: 0.01,
    });

    expect(broker.replaceStopPrice).not.toHaveBeenCalled();
    expect(tradeRepo.patch).not.toHaveBeenCalled();
  });

  it('no toca el stop cuando profitPct < threshold', async () => {
    const ctx = rthContext({ entryLimitPrice: 100 });
    const { broker, tradeRepo } = fakes([ctx]);
    const useCase = new MaybeMoveStopToBreakEven({ broker, tradeRepo });

    await useCase.execute({
      model: 'macd',
      symbol: 'AAPL',
      lastPrice: 100.5, // +0.5%
      threshold: 0.01,
    });

    expect(broker.replaceStopPrice).not.toHaveBeenCalled();
    expect(tradeRepo.patch).not.toHaveBeenCalled();
  });
});
