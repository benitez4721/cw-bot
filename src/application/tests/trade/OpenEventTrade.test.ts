import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrokerPort } from '../../../domain/broker/BrokerPort.js';
import type {
  BracketOrderInput,
  BracketOrderResult,
  OrderResult,
  PlaceLimitOrderInput,
  TrailingBracketOrderInput,
} from '../../../domain/broker/BrokerTypes.js';
import type { EventStrategy } from '../../../domain/decision/EventStrategy.js';
import type { IndicatorPort } from '../../../domain/indicators/IndicatorPort.js';
import type { BarRepository } from '../../../domain/marketdata/BarRepository.js';
import type { HistoricalBarsPort } from '../../../domain/marketdata/HistoricalBarsPort.js';
import type { MetricsPort } from '../../../domain/metrics/MetricsPort.js';
import type { TradeContextRepository } from '../../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../../domain/trade/TradeTypes.js';
import { PlaceBracketOrder } from '../../broker/PlaceBracketOrder.js';
import { PlaceLimitOrder } from '../../broker/PlaceLimitOrder.js';
import { PlaceTrailingBracketOrder } from '../../broker/PlaceTrailingBracketOrder.js';
import { OpenEventTrade } from '../../trade/OpenEventTrade.js';

// Tests de unidad del caso de uso aislado. El gating del alert (sesion,
// exposicion, quote) vive en OnScannerAlert y se testea alla; aca verificamos
// la mecanica de stop/sizing/orden/persistencia para cada (trailMode, session).

const percentStrategy: EventStrategy = {
  name: 'HighOfDayAlert',
  cwConfigId: 'cfg',
  riskUsd: 2000,
  trailMode: 'percent',
  trailingStopPercent: 8,
  entryBufferBps: 0,
  accountId: 'SIM12345',
};

const emaStrategy: EventStrategy = {
  name: 'HighOfDayAlertEmaTrail',
  cwConfigId: 'cfg',
  riskUsd: 2000,
  trailMode: 'ema',
  emaTrailPeriod: 18,
  emaTrailBufferBps: 16,
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

function setup(opts: {
  strategy: EventStrategy;
  placeTrailingResult?: BracketOrderResult;
  placeBracketResult?: BracketOrderResult;
  placeLimitResult?: OrderResult;
  emaValue?: number;
  indicatorsThrows?: boolean;
}) {
  const placeTrailingResult: BracketOrderResult = opts.placeTrailingResult ?? {
    status: 'open',
    entryOrderId: 'E1',
    stopOrderId: 'S1',
  };
  const placeBracketResult: BracketOrderResult = opts.placeBracketResult ?? {
    status: 'open',
    entryOrderId: 'E1',
    stopOrderId: 'S1',
  };
  const placeLimitResult: OrderResult = opts.placeLimitResult ?? {
    status: 'open',
    orderId: 'PRE1',
  };

  const placeTrailingSpy = vi.fn(
    async (_i: TrailingBracketOrderInput) => placeTrailingResult,
  );
  const placeBracketSpy = vi.fn(
    async (_i: BracketOrderInput) => placeBracketResult,
  );
  const placeLimitSpy = vi.fn(
    async (_i: PlaceLimitOrderInput) => placeLimitResult,
  );
  const broker = {
    placeTrailingBracketOrder: placeTrailingSpy,
    placeBracketOrder: placeBracketSpy,
    placeLimitOrder: placeLimitSpy,
  } as unknown as BrokerPort;

  const tradeRepo = {
    put: vi.fn(async () => undefined),
  } as unknown as TradeContextRepository & { put: ReturnType<typeof vi.fn> };

  const metrics = makeMetrics();
  const reconcileSpy = vi.fn(async () => {});

  const cachedArr = Array.from({ length: 30 }, (_, i) => ({
    timestamp: `t${i}`,
    open: 99,
    high: 100,
    low: 98,
    close: 99,
    volume: 1000,
  }));
  const barRepo = {
    get: vi.fn(async () => cachedArr),
    set: vi.fn(async () => undefined),
  } as unknown as BarRepository;
  const historicalBars = {
    fetchHistoricalBars: vi.fn(async () => cachedArr),
  } as unknown as HistoricalBarsPort;
  const indicators = {
    getEMA: opts.indicatorsThrows
      ? vi.fn(async () => {
          throw new Error('insufficient bars');
        })
      : vi.fn(async () => ({ value: opts.emaValue ?? 100, timestamp: 't' })),
  } as unknown as IndicatorPort;

  const useCase = new OpenEventTrade({
    strategy: opts.strategy,
    placeTrailingBracketOrder: new PlaceTrailingBracketOrder(broker),
    placeBracketOrder: new PlaceBracketOrder(broker),
    placeLimitOrder: new PlaceLimitOrder(broker, metrics),
    tradeRepo,
    reconcileEntryFill: { execute: reconcileSpy } as never,
    metrics,
    indicators,
    barRepo,
    historicalBars,
    now: () => 't0',
  });

  return {
    useCase,
    placeTrailingSpy,
    placeBracketSpy,
    placeLimitSpy,
    tradeRepo,
    metrics,
    reconcileSpy,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('OpenEventTrade — percent', () => {
  it('rth: abre trailing bracket, persiste ctx sin stopPrice ni trailingStopPercent', async () => {
    const f = setup({ strategy: percentStrategy });

    await f.useCase.execute({
      symbol: 'ORGN',
      entryLimitPrice: 1.7,
      evalStart: 't0',
      session: 'rth',
    });

    // riskUsd=2000, trail 8% → stopOffset=round2(0.136)=0.14 → floor(2000/0.14)=14285
    expect(f.placeTrailingSpy).toHaveBeenCalledOnce();
    expect(f.placeTrailingSpy.mock.calls[0][0]).toMatchObject({
      symbol: 'ORGN',
      side: 'BUY',
      quantity: 14285,
      trailingStopPercent: 8,
    });
    const ctx = f.tradeRepo.put.mock.calls[0][0] as TradeContext;
    expect(ctx).toMatchObject({
      session: 'rth',
      bracket: { entryOrderId: 'E1', stopOrderId: 'S1' },
    });
    expect(ctx.stopPrice).toBeUndefined();
    expect(ctx.trailingStopPercent).toBeUndefined();
    expect(f.metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlert',
      'opened',
    );
    expect(f.reconcileSpy).toHaveBeenCalledOnce();
  });

  it('pre: abre Limit DYP+ARCA y persiste ctx con stopPrice + trailingStopPercent + syntheticExitFired', async () => {
    const f = setup({ strategy: percentStrategy });

    await f.useCase.execute({
      symbol: 'ORGN',
      entryLimitPrice: 2,
      evalStart: 't0',
      session: 'pre',
    });

    expect(f.placeLimitSpy).toHaveBeenCalledOnce();
    expect(f.placeLimitSpy.mock.calls[0][0]).toMatchObject({
      duration: 'DYP',
      route: 'ARCA',
    });
    const ctx = f.tradeRepo.put.mock.calls[0][0] as TradeContext;
    expect(ctx).toMatchObject({
      session: 'pre',
      syntheticExitFired: false,
      trailingStopPercent: 8,
      stopPrice: 1.84,
      bracket: { entryOrderId: 'PRE1' },
    });
    expect(ctx.bracket.stopOrderId).toBeUndefined();
  });

  it('quantity redondea a 0 → rejected, sin tocar broker ni repo', async () => {
    const f = setup({ strategy: percentStrategy });

    await f.useCase.execute({
      symbol: 'ORGN',
      entryLimitPrice: 30000,
      evalStart: 't0',
      session: 'rth',
    });

    expect(f.placeTrailingSpy).not.toHaveBeenCalled();
    expect(f.tradeRepo.put).not.toHaveBeenCalled();
    expect(f.metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlert',
      'rejected',
    );
  });

  it('broker rechaza el trailing bracket → no persiste y emite rejected', async () => {
    const f = setup({
      strategy: percentStrategy,
      placeTrailingResult: {
        status: 'rejected',
        entryOrderId: '',
        stopOrderId: '',
        error: 'NO_LIQUIDITY',
      },
    });

    await f.useCase.execute({
      symbol: 'ORGN',
      entryLimitPrice: 1.7,
      evalStart: 't0',
      session: 'rth',
    });

    expect(f.tradeRepo.put).not.toHaveBeenCalled();
    expect(f.metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlert',
      'rejected',
    );
  });
});

describe('OpenEventTrade — ema', () => {
  it('rth: stopOffset = entry - EMA*(1-bps); persiste ctx con emaTrailPeriod/BufferBps', async () => {
    // EMA=100, bps=16 → stop=99.84; entry=100 → stopOffset=0.16 → qty=12500.
    const f = setup({ strategy: emaStrategy });

    await f.useCase.execute({
      symbol: 'ORGN',
      entryLimitPrice: 100,
      evalStart: 't0',
      session: 'rth',
    });

    expect(f.placeBracketSpy).toHaveBeenCalledOnce();
    const call = f.placeBracketSpy.mock.calls[0][0];
    expect(call).toMatchObject({ quantity: 12500 });
    expect(call.stopOffset).toBeCloseTo(0.16, 6);
    const ctx = f.tradeRepo.put.mock.calls[0][0] as TradeContext;
    expect(ctx).toMatchObject({
      session: 'rth',
      emaTrailPeriod: 18,
      emaTrailBufferBps: 16,
    });
    expect(ctx.stopPrice).toBeCloseTo(99.84, 6);
    expect(ctx.trailingStopPercent).toBeUndefined();
  });

  it('getEMA lanza → rejected y no persiste', async () => {
    const f = setup({ strategy: emaStrategy, indicatorsThrows: true });

    await f.useCase.execute({
      symbol: 'ORGN',
      entryLimitPrice: 100,
      evalStart: 't0',
      session: 'rth',
    });

    expect(f.placeBracketSpy).not.toHaveBeenCalled();
    expect(f.tradeRepo.put).not.toHaveBeenCalled();
    expect(f.metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlertEmaTrail',
      'rejected',
    );
  });

  it('EMA por encima del entry → rejected (stop no queda debajo del entry)', async () => {
    const f = setup({ strategy: emaStrategy, emaValue: 200 });

    await f.useCase.execute({
      symbol: 'ORGN',
      entryLimitPrice: 100,
      evalStart: 't0',
      session: 'rth',
    });

    expect(f.placeBracketSpy).not.toHaveBeenCalled();
    expect(f.metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlertEmaTrail',
      'rejected',
    );
  });
});
