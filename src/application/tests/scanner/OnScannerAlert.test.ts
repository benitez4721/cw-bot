import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrokerPort } from '../../../domain/broker/BrokerPort.js';
import type {
  BracketOrderResult,
  TrailingBracketOrderInput,
} from '../../../domain/broker/BrokerTypes.js';
import type { EventStrategy } from '../../../domain/decision/EventStrategy.js';
import type { MarketHours } from '../../../domain/market/MarketHours.js';
import type { MetricsPort } from '../../../domain/metrics/MetricsPort.js';
import type { TradeContextRepository } from '../../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../../domain/trade/TradeTypes.js';
import { OnScannerAlert } from '../../scanner/OnScannerAlert.js';
import { PlaceTrailingBracketOrder } from '../../broker/PlaceTrailingBracketOrder.js';
import type { CheckOpenTrades } from '../../trade/CheckOpenTrades.js';

const strategy: EventStrategy = {
  name: 'HighOfDayAlert',
  cwConfigId: 'cfg',
  quantity: 2000,
  trailingStopPercent: 8,
  entryBufferBps: 50,
  accountId: 'SIM12345',
};

function makeMetrics(): MetricsPort & {
  recordAlertOutcome: ReturnType<typeof vi.fn>;
} {
  return {
    recordDecision: vi.fn(),
    recordTick: vi.fn(),
    recordOrderResult: vi.fn(),
    recordTsRequest: vi.fn(),
    recordOauthRefresh: vi.fn(),
    setWatchlistSize: vi.fn(),
    setScannerConnected: vi.fn(),
    recordBarReceived: vi.fn(),
    recordBarDedupSkip: vi.fn(),
    recordBootstrapFailure: vi.fn(),
    setMarketFeedConnected: vi.fn(),
    recordFlattenOutcome: vi.fn(),
    recordFlattenFailure: vi.fn(),
    recordAlertOutcome: vi.fn(),
  };
}

interface Fakes {
  broker: BrokerPort;
  tradeRepo: TradeContextRepository & {
    put: ReturnType<typeof vi.fn>;
  };
  checkOpenTrades: CheckOpenTrades & {
    execute: ReturnType<typeof vi.fn>;
  };
  placeTrailing: PlaceTrailingBracketOrder;
  placeSpy: ReturnType<typeof vi.fn>;
  marketHours: MarketHours;
  metrics: MetricsPort & { recordAlertOutcome: ReturnType<typeof vi.fn> };
}

function makeMarketHours(isOpen: boolean): MarketHours {
  return { isOpen: () => isOpen };
}

function setup(opts: {
  stillExposed?: boolean;
  placeResult?: BracketOrderResult;
  quote?: { ask?: number; last?: number };
  marketOpen?: boolean;
}): Fakes {
  const stillExposed = opts.stillExposed ?? false;
  const placeResult: BracketOrderResult = opts.placeResult ?? {
    status: 'open',
    entryOrderId: 'E1',
    stopOrderId: 'S1',
  };
  const quote = opts.quote ?? { ask: 1.7, last: 1.69 };

  const placeSpy = vi.fn(async (_i: TrailingBracketOrderInput) => placeResult);
  const broker = {
    getQuote: vi.fn(async () => ({
      symbol: 'X',
      last: quote.last ?? 0,
      ask: quote.ask,
      timestamp: 't',
    })),
    placeTrailingBracketOrder: placeSpy,
  } as unknown as BrokerPort;

  const tradeRepo = {
    put: vi.fn(async () => undefined),
  } as unknown as TradeContextRepository & {
    put: ReturnType<typeof vi.fn>;
  };

  const checkOpenTrades = {
    execute: vi.fn(async () => ({ stillExposed })),
  } as unknown as CheckOpenTrades & {
    execute: ReturnType<typeof vi.fn>;
  };

  const placeTrailing = new PlaceTrailingBracketOrder(broker);
  return {
    broker,
    tradeRepo,
    checkOpenTrades,
    placeTrailing,
    placeSpy,
    marketHours: makeMarketHours(opts.marketOpen ?? true),
    metrics: makeMetrics(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OnScannerAlert.handle', () => {
  it('sin trade activo abre bracket trailing y persiste contexto', async () => {
    const f = setup({});
    const useCase = new OnScannerAlert({
      strategy,
      broker: f.broker,
      placeTrailingBracketOrder: f.placeTrailing,
      tradeRepo: f.tradeRepo,
      checkOpenTrades: f.checkOpenTrades,
      marketHours: f.marketHours,
      metrics: f.metrics,
      now: () => 't0',
    });

    await useCase.handle('ORGN');

    expect(f.placeSpy).toHaveBeenCalledOnce();
    const call = f.placeSpy.mock.calls[0][0];
    expect(call).toMatchObject({
      symbol: 'ORGN',
      side: 'BUY',
      quantity: 2000,
      trailingStopPercent: 8,
    });
    // ask 1.7 * (1 + 50/10_000) = 1.7085
    expect(call.entryLimitPrice).toBeCloseTo(1.7085, 6);

    expect(f.tradeRepo.put).toHaveBeenCalledOnce();
    const persisted = f.tradeRepo.put.mock.calls[0][0] as TradeContext;
    expect(persisted).toMatchObject({
      model: 'HighOfDayAlert',
      symbol: 'ORGN',
      side: 'BUY',
      status: 'active',
      bracket: { entryOrderId: 'E1', stopOrderId: 'S1' },
    });
    expect(persisted.bracket.takeProfitOrderId).toBeUndefined();
    expect(f.metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlert',
      'opened',
    );
  });

  it('si CheckOpenTrades reporta still exposed no opera', async () => {
    const f = setup({ stillExposed: true });
    const useCase = new OnScannerAlert({
      strategy,
      broker: f.broker,
      placeTrailingBracketOrder: f.placeTrailing,
      tradeRepo: f.tradeRepo,
      checkOpenTrades: f.checkOpenTrades,
      marketHours: f.marketHours,
      metrics: f.metrics,
    });

    await useCase.handle('ORGN');

    expect(f.checkOpenTrades.execute).toHaveBeenCalledWith({
      model: 'HighOfDayAlert',
      symbol: 'ORGN',
    });
    expect(f.placeSpy).not.toHaveBeenCalled();
    expect(f.tradeRepo.put).not.toHaveBeenCalled();
    expect(f.metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlert',
      'skipped_busy',
    );
  });

  it('CheckOpenTrades reconcilia con el broker y luego abre cuando ya no hay exposición', async () => {
    // Caso del bug: el repo tenía el trade marcado activo, pero el broker
    // ya no tiene órdenes vivas. CheckOpenTrades cierra el contexto y
    // devuelve stillExposed=false, permitiendo la nueva alerta.
    const f = setup({ stillExposed: false });
    const useCase = new OnScannerAlert({
      strategy,
      broker: f.broker,
      placeTrailingBracketOrder: f.placeTrailing,
      tradeRepo: f.tradeRepo,
      checkOpenTrades: f.checkOpenTrades,
      marketHours: f.marketHours,
      metrics: f.metrics,
    });

    await useCase.handle('ORGN');

    expect(f.checkOpenTrades.execute).toHaveBeenCalledWith({
      model: 'HighOfDayAlert',
      symbol: 'ORGN',
    });
    expect(f.placeSpy).toHaveBeenCalledOnce();
    expect(f.tradeRepo.put).toHaveBeenCalledOnce();
    expect(f.metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlert',
      'opened',
    );
  });

  it('rejected del broker no persiste contexto y emite outcome rejected', async () => {
    const f = setup({
      placeResult: {
        status: 'rejected',
        entryOrderId: '',
        stopOrderId: '',
        error: 'NO_LIQUIDITY',
      },
    });
    const useCase = new OnScannerAlert({
      strategy,
      broker: f.broker,
      placeTrailingBracketOrder: f.placeTrailing,
      tradeRepo: f.tradeRepo,
      checkOpenTrades: f.checkOpenTrades,
      marketHours: f.marketHours,
      metrics: f.metrics,
    });

    await useCase.handle('ORGN');

    expect(f.tradeRepo.put).not.toHaveBeenCalled();
    expect(f.metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlert',
      'rejected',
    );
  });

  it('sin ask ni last válidos rechaza la alerta', async () => {
    const f = setup({ quote: { ask: undefined, last: 0 } });
    const useCase = new OnScannerAlert({
      strategy,
      broker: f.broker,
      placeTrailingBracketOrder: f.placeTrailing,
      tradeRepo: f.tradeRepo,
      checkOpenTrades: f.checkOpenTrades,
      marketHours: f.marketHours,
      metrics: f.metrics,
    });

    await useCase.handle('ORGN');

    expect(f.placeSpy).not.toHaveBeenCalled();
    expect(f.metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlert',
      'rejected',
    );
  });

  it('si el mercado está cerrado salta la alerta sin tocar broker ni repo', async () => {
    const f = setup({ marketOpen: false });
    const useCase = new OnScannerAlert({
      strategy,
      broker: f.broker,
      placeTrailingBracketOrder: f.placeTrailing,
      tradeRepo: f.tradeRepo,
      checkOpenTrades: f.checkOpenTrades,
      marketHours: f.marketHours,
      metrics: f.metrics,
    });

    await useCase.handle('ORGN');

    expect(f.checkOpenTrades.execute).not.toHaveBeenCalled();
    expect(f.broker.getQuote).not.toHaveBeenCalled();
    expect(f.placeSpy).not.toHaveBeenCalled();
    expect(f.tradeRepo.put).not.toHaveBeenCalled();
    expect(f.metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlert',
      'skipped_closed',
    );
  });

  it('cae a last cuando no hay ask', async () => {
    const f = setup({ quote: { ask: undefined, last: 2 } });
    const useCase = new OnScannerAlert({
      strategy,
      broker: f.broker,
      placeTrailingBracketOrder: f.placeTrailing,
      tradeRepo: f.tradeRepo,
      checkOpenTrades: f.checkOpenTrades,
      marketHours: f.marketHours,
      metrics: f.metrics,
    });

    await useCase.handle('ORGN');

    const call = f.placeSpy.mock.calls[0][0];
    // last 2 * (1 + 50/10_000) = 2.01
    expect(call.entryLimitPrice).toBeCloseTo(2.01, 6);
  });
});
