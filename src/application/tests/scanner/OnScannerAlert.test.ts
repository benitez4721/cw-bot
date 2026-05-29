import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrokerPort } from '../../../domain/broker/BrokerPort.js';
import type {
  BracketOrderResult,
  OrderResult,
  PlaceLimitOrderInput,
  TrailingBracketOrderInput,
} from '../../../domain/broker/BrokerTypes.js';
import type { EventStrategy } from '../../../domain/decision/EventStrategy.js';
import type { IndicatorPort } from '../../../domain/indicators/IndicatorPort.js';
import type {
  MarketHours,
  Session,
} from '../../../domain/market/MarketHours.js';
import type { BarRepository } from '../../../domain/marketdata/BarRepository.js';
import type { HistoricalBarsPort } from '../../../domain/marketdata/HistoricalBarsPort.js';
import type { MetricsPort } from '../../../domain/metrics/MetricsPort.js';
import type { TradeContextRepository } from '../../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../../domain/trade/TradeTypes.js';
import { OnScannerAlert } from '../../scanner/OnScannerAlert.js';
import { PlaceLimitOrder } from '../../broker/PlaceLimitOrder.js';
import { PlaceBracketOrder } from '../../broker/PlaceBracketOrder.js';
import { PlaceTrailingBracketOrder } from '../../broker/PlaceTrailingBracketOrder.js';
import type { CheckOpenTrades } from '../../trade/CheckOpenTrades.js';

const strategy: EventStrategy = {
  name: 'HighOfDayAlert',
  cwConfigId: 'cfg',
  quantity: 2000,
  trailMode: 'percent',
  trailingStopPercent: 8,
  entryBufferBps: 0,
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
  placeTrailingSpy: ReturnType<typeof vi.fn>;
  placeBracket: PlaceBracketOrder;
  placeBracketSpy: ReturnType<typeof vi.fn>;
  placeLimit: PlaceLimitOrder;
  placeLimitSpy: ReturnType<typeof vi.fn>;
  marketHours: MarketHours;
  metrics: MetricsPort & { recordAlertOutcome: ReturnType<typeof vi.fn> };
}

function makeMarketHours(session: Session): MarketHours {
  return {
    isOpen: () => session === 'rth',
    isConnected: () => session === 'pre' || session === 'rth',
    session: () => session,
  };
}

function setup(opts: {
  stillExposed?: boolean;
  placeTrailingResult?: BracketOrderResult;
  placeLimitResult?: OrderResult;
  quote?: { ask?: number; last?: number };
  session?: Session;
}): Fakes {
  const stillExposed = opts.stillExposed ?? false;
  const placeTrailingResult: BracketOrderResult = opts.placeTrailingResult ?? {
    status: 'open',
    entryOrderId: 'E1',
    stopOrderId: 'S1',
  };
  const placeLimitResult: OrderResult = opts.placeLimitResult ?? {
    status: 'open',
    orderId: 'PRE1',
  };
  const quote = opts.quote ?? { ask: 1.7, last: 1.69 };

  const placeTrailingSpy = vi.fn(
    async (_i: TrailingBracketOrderInput) => placeTrailingResult,
  );
  const placeLimitSpy = vi.fn(
    async (_i: PlaceLimitOrderInput) => placeLimitResult,
  );
  const placeBracketSpy = vi.fn(async () => ({
    status: 'open' as const,
    entryOrderId: 'E1',
    stopOrderId: 'S1',
  }));
  const broker = {
    getQuote: vi.fn(async () => ({
      symbol: 'X',
      last: quote.last ?? 0,
      ask: quote.ask,
      timestamp: 't',
    })),
    placeTrailingBracketOrder: placeTrailingSpy,
    placeBracketOrder: placeBracketSpy,
    placeLimitOrder: placeLimitSpy,
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

  const metrics = makeMetrics();
  const placeTrailing = new PlaceTrailingBracketOrder(broker);
  const placeBracket = new PlaceBracketOrder(broker);
  const placeLimit = new PlaceLimitOrder(broker, metrics);
  return {
    broker,
    tradeRepo,
    checkOpenTrades,
    placeTrailing,
    placeTrailingSpy,
    placeBracket,
    placeBracketSpy,
    placeLimit,
    placeLimitSpy,
    marketHours: makeMarketHours(opts.session ?? 'rth'),
    metrics,
  };
}

function build(f: Fakes, now?: () => string): OnScannerAlert {
  return new OnScannerAlert({
    strategy,
    broker: f.broker,
    placeTrailingBracketOrder: f.placeTrailing,
    placeBracketOrder: f.placeBracket,
    placeLimitOrder: f.placeLimit,
    tradeRepo: f.tradeRepo,
    checkOpenTrades: f.checkOpenTrades,
    reconcileEntryFill: { execute: vi.fn(async () => {}) } as never,
    marketHours: f.marketHours,
    metrics: f.metrics,
    now,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OnScannerAlert.handle — RTH', () => {
  it('sin trade activo abre bracket trailing y persiste contexto', async () => {
    const f = setup({});
    const useCase = build(f, () => 't0');

    await useCase.handle('ORGN');

    expect(f.placeTrailingSpy).toHaveBeenCalledOnce();
    expect(f.placeLimitSpy).not.toHaveBeenCalled();
    const call = f.placeTrailingSpy.mock.calls[0][0];
    expect(call).toMatchObject({
      symbol: 'ORGN',
      side: 'BUY',
      quantity: 2000,
      trailingStopPercent: 8,
    });
    expect(call.entryLimitPrice).toBeCloseTo(1.7, 6);

    expect(f.tradeRepo.put).toHaveBeenCalledOnce();
    const persisted = f.tradeRepo.put.mock.calls[0][0] as TradeContext;
    expect(persisted).toMatchObject({
      model: 'HighOfDayAlert',
      symbol: 'ORGN',
      side: 'BUY',
      status: 'active',
      session: 'rth',
      bracket: { entryOrderId: 'E1', stopOrderId: 'S1' },
    });
    expect(persisted.bracket.takeProfitOrderId).toBeUndefined();
    expect(persisted.trailingStopPercent).toBeUndefined();
    expect(persisted.stopPrice).toBeUndefined();
    expect(f.metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlert',
      'opened',
    );
  });

  it('si CheckOpenTrades reporta still exposed no opera', async () => {
    const f = setup({ stillExposed: true });
    const useCase = build(f);

    await useCase.handle('ORGN');

    expect(f.checkOpenTrades.execute).toHaveBeenCalledWith({
      model: 'HighOfDayAlert',
      symbol: 'ORGN',
    });
    expect(f.placeTrailingSpy).not.toHaveBeenCalled();
    expect(f.placeLimitSpy).not.toHaveBeenCalled();
    expect(f.tradeRepo.put).not.toHaveBeenCalled();
    expect(f.metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlert',
      'skipped_busy',
    );
  });

  it('CheckOpenTrades reconcilia con el broker y luego abre cuando ya no hay exposicion', async () => {
    const f = setup({ stillExposed: false });
    const useCase = build(f);

    await useCase.handle('ORGN');

    expect(f.checkOpenTrades.execute).toHaveBeenCalledWith({
      model: 'HighOfDayAlert',
      symbol: 'ORGN',
    });
    expect(f.placeTrailingSpy).toHaveBeenCalledOnce();
    expect(f.tradeRepo.put).toHaveBeenCalledOnce();
    expect(f.metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlert',
      'opened',
    );
  });

  it('rejected del broker no persiste contexto y emite outcome rejected', async () => {
    const f = setup({
      placeTrailingResult: {
        status: 'rejected',
        entryOrderId: '',
        stopOrderId: '',
        error: 'NO_LIQUIDITY',
      },
    });
    const useCase = build(f);

    await useCase.handle('ORGN');

    expect(f.tradeRepo.put).not.toHaveBeenCalled();
    expect(f.metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlert',
      'rejected',
    );
  });

  it('sin ask ni last validos rechaza la alerta', async () => {
    const f = setup({ quote: { ask: undefined, last: 0 } });
    const useCase = build(f);

    await useCase.handle('ORGN');

    expect(f.placeTrailingSpy).not.toHaveBeenCalled();
    expect(f.metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlert',
      'rejected',
    );
  });

  it('sin ask rechaza la alerta aunque haya last', async () => {
    const f = setup({ quote: { ask: undefined, last: 2 } });
    const useCase = build(f);

    await useCase.handle('ORGN');

    expect(f.placeTrailingSpy).not.toHaveBeenCalled();
    expect(f.tradeRepo.put).not.toHaveBeenCalled();
    expect(f.metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlert',
      'rejected',
    );
  });
});

describe('OnScannerAlert.handle — sesion no tradeable', () => {
  it('mercado closed: skipea sin tocar broker ni repo', async () => {
    const f = setup({ session: 'closed' });
    const useCase = build(f);

    await useCase.handle('ORGN');

    expect(f.checkOpenTrades.execute).not.toHaveBeenCalled();
    expect(f.broker.getQuote).not.toHaveBeenCalled();
    expect(f.placeTrailingSpy).not.toHaveBeenCalled();
    expect(f.placeLimitSpy).not.toHaveBeenCalled();
    expect(f.tradeRepo.put).not.toHaveBeenCalled();
    expect(f.metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlert',
      'skipped_closed',
    );
  });

  it('transition (9:20-9:30): skipea — ventana de flatten, no abrir nada', async () => {
    const f = setup({ session: 'transition' });
    const useCase = build(f);

    await useCase.handle('ORGN');

    expect(f.placeTrailingSpy).not.toHaveBeenCalled();
    expect(f.placeLimitSpy).not.toHaveBeenCalled();
    expect(f.tradeRepo.put).not.toHaveBeenCalled();
    expect(f.metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlert',
      'skipped_closed',
    );
  });
});

describe('OnScannerAlert.handle — PRE', () => {
  it('abre Limit DYP+ARCA y persiste ctx pre con stop sintetico + trailingStopPercent', async () => {
    const f = setup({ session: 'pre', quote: { ask: 2, last: 1.99 } });
    const useCase = build(f, () => 't0');

    await useCase.handle('ORGN');

    expect(f.placeTrailingSpy).not.toHaveBeenCalled();
    expect(f.placeLimitSpy).toHaveBeenCalledOnce();
    const limitCall = f.placeLimitSpy.mock.calls[0][0];
    expect(limitCall).toMatchObject({
      symbol: 'ORGN',
      side: 'BUY',
      quantity: 2000,
      limitPrice: 2,
      accountId: 'SIM12345',
      duration: 'DYP',
      route: 'ARCA',
    });

    expect(f.tradeRepo.put).toHaveBeenCalledOnce();
    const persisted = f.tradeRepo.put.mock.calls[0][0] as TradeContext;
    // stop sintetico inicial = entryLimitPrice * (1 - 8/100) = 2 * 0.92 = 1.84
    expect(persisted).toMatchObject({
      model: 'HighOfDayAlert',
      symbol: 'ORGN',
      side: 'BUY',
      session: 'pre',
      status: 'active',
      syntheticExitFired: false,
      trailingStopPercent: 8,
      stopPrice: 1.84,
      bracket: { entryOrderId: 'PRE1' },
    });
    expect(persisted.takeProfitPrice).toBeUndefined();
    expect(persisted.bracket.stopOrderId).toBeUndefined();
    expect(f.metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlert',
      'opened',
    );
  });

  it('rejected del Limit pre no persiste y emite rejected', async () => {
    const f = setup({
      session: 'pre',
      placeLimitResult: {
        status: 'rejected',
        orderId: '',
        error: 'NO_LIQUIDITY',
      },
    });
    const useCase = build(f);

    await useCase.handle('ORGN');

    expect(f.tradeRepo.put).not.toHaveBeenCalled();
    expect(f.metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlert',
      'rejected',
    );
  });

  it('expired del Limit pre no persiste', async () => {
    const f = setup({
      session: 'pre',
      placeLimitResult: { status: 'expired', orderId: '' },
    });
    const useCase = build(f);

    await useCase.handle('ORGN');

    expect(f.tradeRepo.put).not.toHaveBeenCalled();
    expect(f.metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlert',
      'rejected',
    );
  });
});

// ============================================================================
// Suite EMA: variante de la EventStrategy con trail por EMA en lugar de %.
// El stop inicial se calcula al submit con la EMA actual; la rama rth manda
// placeBracketOrder (sin TP); la rama pre manda placeLimitOrder + stop
// sintetico inicial.
// ============================================================================

const emaStrategy: EventStrategy = {
  name: 'HighOfDayAlertEmaTrail',
  cwConfigId: 'cfg',
  quantity: 2000,
  trailMode: 'ema',
  emaTrailPeriod: 18,
  emaTrailBufferBps: 16,
  entryBufferBps: 0,
  accountId: 'SIM12345',
};

interface EmaFakes {
  broker: BrokerPort;
  tradeRepo: TradeContextRepository & { put: ReturnType<typeof vi.fn> };
  checkOpenTrades: CheckOpenTrades & {
    execute: ReturnType<typeof vi.fn>;
  };
  placeTrailing: PlaceTrailingBracketOrder;
  placeBracket: PlaceBracketOrder;
  placeBracketSpy: ReturnType<typeof vi.fn>;
  placeLimit: PlaceLimitOrder;
  placeLimitSpy: ReturnType<typeof vi.fn>;
  marketHours: MarketHours;
  metrics: MetricsPort & { recordAlertOutcome: ReturnType<typeof vi.fn> };
  indicators: { getEMA: ReturnType<typeof vi.fn> };
  barRepo: {
    get: ReturnType<typeof vi.fn>;
    set: ReturnType<typeof vi.fn>;
    append: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  historicalBars: { fetchHistoricalBars: ReturnType<typeof vi.fn> };
}

function emaSetup(
  opts: {
    session?: Session;
    quote?: { ask?: number; last?: number };
    emaValue?: number;
    cachedBars?: number;
    placeBracketResult?: BracketOrderResult;
    placeLimitResult?: OrderResult;
    indicatorsThrows?: boolean;
  } = {},
): EmaFakes {
  const quote = opts.quote ?? { ask: 100, last: 100 };
  const placeBracketResult: BracketOrderResult = opts.placeBracketResult ?? {
    status: 'open',
    entryOrderId: 'E1',
    stopOrderId: 'S1',
  };
  const placeLimitResult: OrderResult = opts.placeLimitResult ?? {
    orderId: 'PRE1',
    status: 'open',
  };
  const placeBracketSpy = vi.fn(async () => placeBracketResult);
  const placeLimitSpy = vi.fn(async () => placeLimitResult);
  const placeTrailingSpy = vi.fn();
  const broker = {
    getQuote: vi.fn(async () => ({
      symbol: 'X',
      last: quote.last ?? 0,
      ask: quote.ask,
      timestamp: 't',
    })),
    placeTrailingBracketOrder: placeTrailingSpy,
    placeBracketOrder: placeBracketSpy,
    placeLimitOrder: placeLimitSpy,
  } as unknown as BrokerPort;

  const tradeRepo = {
    put: vi.fn(async () => undefined),
  } as unknown as TradeContextRepository & {
    put: ReturnType<typeof vi.fn>;
  };
  const checkOpenTrades = {
    execute: vi.fn(async () => ({ stillExposed: false })),
  } as unknown as CheckOpenTrades & {
    execute: ReturnType<typeof vi.fn>;
  };
  const metrics = makeMetrics();
  const placeTrailing = new PlaceTrailingBracketOrder(broker);
  const placeBracket = new PlaceBracketOrder(broker);
  const placeLimit = new PlaceLimitOrder(broker, metrics);

  // Bars en cache simuladas. Si opts.cachedBars >= period, no se invoca
  // historicalBars.fetchHistoricalBars.
  const cached = opts.cachedBars ?? 30;
  const cachedArr = Array.from({ length: cached }, (_, i) => ({
    timestamp: `t${i}`,
    open: 99,
    high: 100,
    low: 98,
    close: 99 + (i % 3),
    volume: 1000,
  }));
  const barRepo = {
    get: vi.fn(async () => cachedArr),
    set: vi.fn(async () => undefined),
    append: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  };
  const historicalBars = {
    fetchHistoricalBars: vi.fn(async () => cachedArr),
  };
  const emaValue = opts.emaValue ?? 100;
  const indicators = {
    getEMA: opts.indicatorsThrows
      ? vi.fn(async () => {
          throw new Error('insufficient bars');
        })
      : vi.fn(async () => ({ value: emaValue, timestamp: 't' })),
  };

  return {
    broker,
    tradeRepo,
    checkOpenTrades,
    placeTrailing,
    placeBracket,
    placeBracketSpy,
    placeLimit,
    placeLimitSpy,
    marketHours: makeMarketHours(opts.session ?? 'rth'),
    metrics,
    indicators,
    barRepo,
    historicalBars,
  };
}

function emaBuild(f: EmaFakes, now?: () => string): OnScannerAlert {
  return new OnScannerAlert({
    strategy: emaStrategy,
    broker: f.broker,
    placeTrailingBracketOrder: f.placeTrailing,
    placeBracketOrder: f.placeBracket,
    placeLimitOrder: f.placeLimit,
    tradeRepo: f.tradeRepo,
    checkOpenTrades: f.checkOpenTrades,
    reconcileEntryFill: { execute: vi.fn(async () => {}) } as never,
    marketHours: f.marketHours,
    metrics: f.metrics,
    indicators: f.indicators as unknown as IndicatorPort,
    barRepo: f.barRepo as unknown as BarRepository,
    historicalBars: f.historicalBars as unknown as HistoricalBarsPort,
    now,
  });
}

describe('OnScannerAlert.handle — trail EMA (rth)', () => {
  it('abre placeBracketOrder con stopOffset = entry - EMA*(1-bps/10000); persiste ctx con emaTrailPeriod/BufferBps', async () => {
    // EMA=100, bps=16 → stop = 100 * (1 - 16/10000) = 99.84.
    // entry = ask * (1 + 0) = 100 (entryBufferBps=0).
    // stopOffset = 100 - 99.84 = 0.16.
    const f = emaSetup({});
    const useCase = emaBuild(f, () => 't0');

    await useCase.handle('ORGN');

    expect(f.placeBracketSpy).toHaveBeenCalledOnce();
    const call = f.placeBracketSpy.mock.calls[0][0];
    expect(call).toMatchObject({
      symbol: 'ORGN',
      side: 'BUY',
      quantity: 2000,
      accountId: 'SIM12345',
    });
    expect(call.entryLimitPrice).toBeCloseTo(100, 6);
    expect(call.stopOffset).toBeCloseTo(0.16, 6);
    expect(call.takeProfitOffset).toBeUndefined();

    expect(f.tradeRepo.put).toHaveBeenCalledOnce();
    const persisted = f.tradeRepo.put.mock.calls[0][0] as TradeContext;
    expect(persisted).toMatchObject({
      model: 'HighOfDayAlertEmaTrail',
      symbol: 'ORGN',
      side: 'BUY',
      session: 'rth',
      status: 'active',
      emaTrailPeriod: 18,
      emaTrailBufferBps: 16,
      bracket: { entryOrderId: 'E1', stopOrderId: 'S1' },
    });
    expect(persisted.stopPrice).toBeCloseTo(99.84, 6);
    expect(persisted.trailingStopPercent).toBeUndefined();
  });

  it('bootstrap on-demand: si barRepo.get devuelve menos que period, llama historicalBars.fetchHistoricalBars y barRepo.set antes de getEMA', async () => {
    const f = emaSetup({ cachedBars: 3 });
    const useCase = emaBuild(f, () => 't0');

    await useCase.handle('ORGN');

    expect(f.historicalBars.fetchHistoricalBars).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'ORGN', interval: '1min' }),
    );
    expect(f.barRepo.set).toHaveBeenCalled();
    expect(f.placeBracketSpy).toHaveBeenCalledOnce();
  });

  it('skip bootstrap cuando barRepo.get ya tiene >= period barras', async () => {
    const f = emaSetup({ cachedBars: 50 });
    const useCase = emaBuild(f, () => 't0');

    await useCase.handle('ORGN');

    expect(f.historicalBars.fetchHistoricalBars).not.toHaveBeenCalled();
    expect(f.barRepo.set).not.toHaveBeenCalled();
  });

  it('getEMA lanza → outcome rejected y NO se persiste ctx', async () => {
    const f = emaSetup({ indicatorsThrows: true });
    const useCase = emaBuild(f, () => 't0');

    await useCase.handle('ORGN');

    expect(f.tradeRepo.put).not.toHaveBeenCalled();
    expect(f.placeBracketSpy).not.toHaveBeenCalled();
    expect(f.metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlertEmaTrail',
      'rejected',
    );
  });

  it('EMA por encima del entry: stop derivado >= entry → outcome rejected', async () => {
    // EMA=200, entry=100 → stop = 199.68 > entry → rechazo.
    const f = emaSetup({ emaValue: 200 });
    const useCase = emaBuild(f, () => 't0');

    await useCase.handle('ORGN');

    expect(f.placeBracketSpy).not.toHaveBeenCalled();
    expect(f.metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlertEmaTrail',
      'rejected',
    );
  });

  it('placeBracketOrder rejected por broker no persiste ctx', async () => {
    const f = emaSetup({
      placeBracketResult: {
        status: 'rejected',
        entryOrderId: '',
        stopOrderId: '',
        error: 'NO_LIQUIDITY',
      },
    });
    const useCase = emaBuild(f, () => 't0');

    await useCase.handle('ORGN');

    expect(f.tradeRepo.put).not.toHaveBeenCalled();
    expect(f.metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlertEmaTrail',
      'rejected',
    );
  });
});

describe('OnScannerAlert.handle — trail EMA (pre)', () => {
  it('abre Limit DYP+ARCA y persiste ctx pre con stopPrice = EMA*(1-bps) y emaTrailPeriod/BufferBps', async () => {
    const f = emaSetup({ session: 'pre' });
    const useCase = emaBuild(f, () => 't0');

    await useCase.handle('ORGN');

    expect(f.placeLimitSpy).toHaveBeenCalledOnce();
    expect(f.placeLimitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'ORGN',
        side: 'BUY',
        duration: 'DYP',
        route: 'ARCA',
      }),
    );
    expect(f.placeBracketSpy).not.toHaveBeenCalled();

    const persisted = f.tradeRepo.put.mock.calls[0][0] as TradeContext;
    expect(persisted).toMatchObject({
      model: 'HighOfDayAlertEmaTrail',
      symbol: 'ORGN',
      session: 'pre',
      status: 'active',
      syntheticExitFired: false,
      emaTrailPeriod: 18,
      emaTrailBufferBps: 16,
      bracket: { entryOrderId: 'PRE1' },
    });
    expect(persisted.stopPrice).toBeCloseTo(99.84, 6);
    expect(persisted.bracket.stopOrderId).toBeUndefined();
  });
});
