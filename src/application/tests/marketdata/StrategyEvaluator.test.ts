import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BracketOrderInput,
  PlaceLimitOrderInput,
} from '../../../domain/broker/BrokerTypes.js';
import type { DecisionStrategy } from '../../../domain/decision/DecisionStrategy.js';
import type { DecisionSignal } from '../../../domain/decision/DecisionTypes.js';
import { CacheUnderfilledError } from '../../../domain/indicators/IndicatorErrors.js';
import type {
  MarketHours,
  Session,
} from '../../../domain/market/MarketHours.js';
import type { Bar } from '../../../domain/marketdata/MarketDataTypes.js';
import type { MetricsPort } from '../../../domain/metrics/MetricsPort.js';
import type { TradeContext } from '../../../domain/trade/TradeTypes.js';
import { StrategyEvaluator } from '../../marketdata/StrategyEvaluator.js';
import type { StrategyEvaluatorOptions } from '../../marketdata/StrategyEvaluator.js';

function bar(close = 100): Bar {
  return {
    timestamp: '2026-01-15T14:31:00Z',
    open: close,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 1000,
  };
}

function buySignal(): DecisionSignal<unknown> {
  return {
    action: 'buy',
    symbol: 'AAPL',
    side: 'BUY',
    entryLimitPrice: 100.05,
    quantity: 100,
    stopOffset: 0.2,
    takeProfitOffset: 0.35,
    checks: [],
    snapshot: {},
  };
}

function makeMetrics(): MetricsPort & {
  recordDecision: ReturnType<typeof vi.fn>;
  recordOrderResult: ReturnType<typeof vi.fn>;
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

function makeMarketHours(session: Session): MarketHours {
  return {
    isOpen: () => session === 'rth',
    isConnected: () => session === 'pre' || session === 'rth',
    session: () => session,
  };
}

function makeStrategy(opts: {
  signal: DecisionSignal<unknown>;
  buildSnapshot?: ReturnType<typeof vi.fn>;
  trailToBreakEvenAtProfit?: number;
}): DecisionStrategy {
  return {
    name: 'MacdM1CrossOver',
    accountId: 'SIM12345',
    trailToBreakEvenAtProfit: opts.trailToBreakEvenAtProfit,
    watchlist: { getBySymbol: vi.fn(async () => ({ symbol: 'AAPL' })) },
    model: {
      buildSnapshot:
        opts.buildSnapshot ?? vi.fn(async () => opts.signal.snapshot),
      evaluate: vi.fn(() => opts.signal),
    },
  } as unknown as DecisionStrategy;
}

function setup(opts: {
  session: Session;
  strategy: DecisionStrategy;
  stillExposed?: boolean;
  maybeMoveStopToBreakEven?: { execute: ReturnType<typeof vi.fn> };
}) {
  const placeBracketSpy = vi.fn(async (_i: BracketOrderInput) => ({
    status: 'open' as const,
    entryOrderId: 'E1',
    stopOrderId: 'S1',
    takeProfitOrderId: 'T1',
  }));
  const placeLimitSpy = vi.fn(async (_i: PlaceLimitOrderInput) => ({
    status: 'open' as const,
    orderId: 'PRE1',
  }));
  const recordTradeContextSpy = vi.fn(async () => ({}) as TradeContext);
  const reconcileSpy = vi.fn(async () => {});
  const checkOpenTradesSpy = vi.fn(async () => ({
    stillExposed: opts.stillExposed ?? false,
  }));
  const recoverCache = vi.fn();
  const metrics = makeMetrics();

  const options: StrategyEvaluatorOptions = {
    strategies: [opts.strategy],
    placeBracketOrder: { execute: placeBracketSpy } as never,
    recordTradeContext: { execute: recordTradeContextSpy } as never,
    reconcileEntryFill: { execute: reconcileSpy } as never,
    checkOpenTrades: { execute: checkOpenTradesSpy } as never,
    maybeMoveStopToBreakEven: opts.maybeMoveStopToBreakEven as never,
    marketHours: makeMarketHours(opts.session),
    metrics,
    placeLimitOrder: { execute: placeLimitSpy } as never,
    now: () => 0,
    recoverCache,
  };

  return {
    evaluator: new StrategyEvaluator(options),
    placeBracketSpy,
    placeLimitSpy,
    recordTradeContextSpy,
    reconcileSpy,
    checkOpenTradesSpy,
    recoverCache,
    metrics,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('StrategyEvaluator — gating de sesion', () => {
  it('sesion no tradeable (closed): no evalua estrategias', async () => {
    const f = setup({
      session: 'closed',
      strategy: makeStrategy({ signal: buySignal() }),
    });

    await f.evaluator.processSymbol('AAPL', bar());

    expect(f.checkOpenTradesSpy).not.toHaveBeenCalled();
    expect(f.placeBracketSpy).not.toHaveBeenCalled();
  });
});

describe('StrategyEvaluator — rth', () => {
  it('signal buy sin exposicion → placeBracketOrder + recordTradeContext + reconcile', async () => {
    const f = setup({
      session: 'rth',
      strategy: makeStrategy({ signal: buySignal() }),
    });

    await f.evaluator.processSymbol('AAPL', bar());

    expect(f.metrics.recordDecision).toHaveBeenCalledWith('AAPL', 'buy');
    expect(f.placeBracketSpy).toHaveBeenCalledOnce();
    expect(f.placeBracketSpy.mock.calls[0][0]).toMatchObject({
      symbol: 'AAPL',
      side: 'BUY',
      quantity: 100,
      stopOffset: 0.2,
    });
    expect(f.recordTradeContextSpy).toHaveBeenCalledOnce();
    expect(f.reconcileSpy).toHaveBeenCalledOnce();
    expect(f.placeLimitSpy).not.toHaveBeenCalled();
  });

  it('signal hold → registra decision pero no coloca orden', async () => {
    const hold: DecisionSignal<unknown> = {
      action: 'hold',
      checks: [],
      snapshot: {},
    };
    const f = setup({
      session: 'rth',
      strategy: makeStrategy({ signal: hold }),
    });

    await f.evaluator.processSymbol('AAPL', bar());

    expect(f.metrics.recordDecision).toHaveBeenCalledWith('AAPL', 'hold');
    expect(f.placeBracketSpy).not.toHaveBeenCalled();
  });

  it('still exposed con trailToBreakEvenAtProfit → mueve stop a break-even, no coloca', async () => {
    const moveStop = { execute: vi.fn(async () => {}) };
    const f = setup({
      session: 'rth',
      stillExposed: true,
      strategy: makeStrategy({
        signal: buySignal(),
        trailToBreakEvenAtProfit: 0.5,
      }),
      maybeMoveStopToBreakEven: moveStop,
    });

    await f.evaluator.processSymbol('AAPL', bar());

    expect(moveStop.execute).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'MacdM1CrossOver', symbol: 'AAPL' }),
    );
    expect(f.placeBracketSpy).not.toHaveBeenCalled();
  });
});

describe('StrategyEvaluator — pre', () => {
  it('signal buy en pre → placeLimitOrder (no bracket)', async () => {
    const f = setup({
      session: 'pre',
      strategy: makeStrategy({ signal: buySignal() }),
    });

    await f.evaluator.processSymbol('AAPL', bar());

    expect(f.placeLimitSpy).toHaveBeenCalledOnce();
    expect(f.placeLimitSpy.mock.calls[0][0]).toMatchObject({
      duration: 'DYP',
      route: 'ARCA',
    });
    expect(f.placeBracketSpy).not.toHaveBeenCalled();
  });
});

describe('StrategyEvaluator — recoverCache', () => {
  it('CacheUnderfilledError durante la evaluacion → invoca el callback recoverCache', async () => {
    const f = setup({
      session: 'rth',
      strategy: makeStrategy({
        signal: buySignal(),
        buildSnapshot: vi.fn(async () => {
          throw new CacheUnderfilledError('cache underfilled for AAPL');
        }),
      }),
    });

    await f.evaluator.processSymbol('AAPL', bar());

    expect(f.recoverCache).toHaveBeenCalledWith('AAPL');
    expect(f.placeBracketSpy).not.toHaveBeenCalled();
  });
});
