import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DecisionModel } from '../../../domain/decision/DecisionModel.js';
import type { EventStrategy } from '../../../domain/decision/EventStrategy.js';
import type { MetricsPort } from '../../../domain/metrics/MetricsPort.js';
import type { ScannerFeedPort } from '../../../domain/scanner/ScannerFeedPort.js';
import type {
  ScannerColumn,
  ScannerRow,
} from '../../../domain/scanner/ScannerTypes.js';
import { AlertEventManager } from '../../scanner/AlertEventManager.js';
import type { OnScannerAlert } from '../../scanner/OnScannerAlert.js';

const strategy: EventStrategy = {
  name: 'HighOfDayAlert',
  cwConfigId: 'cfg-A',
  quantity: 2000,
  trailMode: 'percent',
  trailingStopPercent: 8,
  entryBufferBps: 50,
  accountId: 'SIM12345',
};

class FakeFeed implements ScannerFeedPort {
  private alertCb: ((configId: string, row: ScannerRow) => void) | null = null;
  connectCalls = 0;
  subscribedAlertConfigs: string[] = [];

  async connect(): Promise<void> {
    this.connectCalls += 1;
  }
  disconnect(): void {}
  subscribe(_id: string): void {}
  onUpdate(_cb: (configId: string, rows: ScannerRow[]) => void): void {}
  subscribeAlert(configId: string): void {
    this.subscribedAlertConfigs.push(configId);
  }
  onAlert(cb: (configId: string, row: ScannerRow) => void): void {
    this.alertCb = cb;
  }
  onConnectionChange(_cb: (connected: boolean) => void): void {}

  emit(configId: string, symbol: string, columns: ScannerColumn[] = []): void {
    this.alertCb?.(configId, { symbol, columns });
  }
}

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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AlertEventManager', () => {
  it('se suscribe al feed con el cwConfigId de la strategy', async () => {
    const feed = new FakeFeed();
    const onAlert = {
      handle: vi.fn(async () => undefined),
    } as unknown as OnScannerAlert;
    const mgr = new AlertEventManager({
      feed,
      strategy,
      onAlert,
      metrics: makeMetrics(),
    });
    await mgr.start();
    expect(feed.subscribedAlertConfigs).toEqual(['cfg-A']);
    expect(feed.connectCalls).toBe(1);
  });

  it('ignora eventos de otro cwConfigId', async () => {
    const feed = new FakeFeed();
    const handle = vi.fn(async () => undefined);
    const onAlert = { handle } as unknown as OnScannerAlert;
    const mgr = new AlertEventManager({
      feed,
      strategy,
      onAlert,
      metrics: makeMetrics(),
    });
    await mgr.start();
    feed.emit('otro-cfg', 'AAPL');
    await new Promise((r) => setTimeout(r, 0));
    expect(handle).not.toHaveBeenCalled();
  });

  it('procesa los eventos en serie — el segundo handle espera al primero', async () => {
    const feed = new FakeFeed();
    const order: string[] = [];
    let resolveFirst: () => void = () => {};
    const firstStarted: Promise<void> = new Promise((r) => {
      resolveFirst = r;
    });
    let releaseFirst: () => void = () => {};
    const firstHold: Promise<void> = new Promise((r) => {
      releaseFirst = r;
    });
    const handle = vi.fn(async (symbol: string) => {
      order.push(`start:${symbol}`);
      if (symbol === 'AAPL') {
        resolveFirst();
        await firstHold;
      }
      order.push(`end:${symbol}`);
    });
    const onAlert = { handle } as unknown as OnScannerAlert;
    const mgr = new AlertEventManager({
      feed,
      strategy,
      onAlert,
      metrics: makeMetrics(),
    });
    await mgr.start();

    feed.emit('cfg-A', 'AAPL');
    feed.emit('cfg-A', 'MSFT');

    await firstStarted;
    expect(order).toEqual(['start:AAPL']);
    releaseFirst();

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual(['start:AAPL', 'end:AAPL', 'start:MSFT', 'end:MSFT']);
  });

  it('cuenta cada alerta recibida como outcome=received', async () => {
    const feed = new FakeFeed();
    const onAlert = {
      handle: vi.fn(async () => undefined),
    } as unknown as OnScannerAlert;
    const metrics = makeMetrics();
    const mgr = new AlertEventManager({ feed, strategy, onAlert, metrics });
    await mgr.start();
    feed.emit('cfg-A', 'AAPL');
    feed.emit('cfg-A', 'MSFT');
    feed.emit('otro-cfg', 'TSLA');
    expect(metrics.recordAlertOutcome).toHaveBeenCalledTimes(2);
    expect(metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlert',
      'received',
    );
  });
});

describe('AlertEventManager — model gate', () => {
  function makeGateModel(decision: 'buy' | 'hold'): DecisionModel {
    type Snap = { decision: 'buy' | 'hold' };
    const model: DecisionModel<Snap> = {
      name: 'GateMock',
      async buildSnapshot() {
        return { decision };
      },
      evaluate(snapshot) {
        const checks = [{ name: 'gate', passed: decision === 'buy' }];
        if (snapshot.decision === 'hold') {
          return { action: 'hold', checks, snapshot };
        }
        return {
          action: 'buy',
          symbol: '',
          side: 'BUY',
          entryLimitPrice: 0,
          quantity: 0,
          stopOffset: 0,
          takeProfitOffset: 0,
          checks,
          snapshot,
        };
      },
    };
    return model as DecisionModel;
  }

  it('sin model declarado, pasa la alerta al handle (back-compat)', async () => {
    const feed = new FakeFeed();
    const handle = vi.fn(async () => undefined);
    const onAlert = { handle } as unknown as OnScannerAlert;
    const mgr = new AlertEventManager({
      feed,
      strategy,
      onAlert,
      metrics: makeMetrics(),
    });
    await mgr.start();
    feed.emit('cfg-A', 'AAPL', [
      { key: 'AlertNameColumn', value: 'lo que sea' },
    ]);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(handle).toHaveBeenCalledWith('AAPL');
  });

  it('con model que retorna buy, invoca handle y NO registra skipped_model_hold', async () => {
    const feed = new FakeFeed();
    const handle = vi.fn(async () => undefined);
    const onAlert = { handle } as unknown as OnScannerAlert;
    const metrics = makeMetrics();
    const strategyWithModel: EventStrategy = {
      ...strategy,
      model: makeGateModel('buy'),
    };
    const mgr = new AlertEventManager({
      feed,
      strategy: strategyWithModel,
      onAlert,
      metrics,
    });
    await mgr.start();
    feed.emit('cfg-A', 'AAPL', [
      { key: 'AlertNameColumn', value: 'High of the day' },
    ]);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(handle).toHaveBeenCalledWith('AAPL');
    expect(metrics.recordAlertOutcome).not.toHaveBeenCalledWith(
      'HighOfDayAlert',
      'skipped_model_hold',
    );
  });

  it('con model que retorna hold, NO invoca handle y registra skipped_model_hold', async () => {
    const feed = new FakeFeed();
    const handle = vi.fn(async () => undefined);
    const onAlert = { handle } as unknown as OnScannerAlert;
    const metrics = makeMetrics();
    const strategyWithModel: EventStrategy = {
      ...strategy,
      model: makeGateModel('hold'),
    };
    const mgr = new AlertEventManager({
      feed,
      strategy: strategyWithModel,
      onAlert,
      metrics,
    });
    await mgr.start();
    feed.emit('cfg-A', 'AAPL', [
      { key: 'AlertNameColumn', value: 'Low of the day' },
    ]);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(handle).not.toHaveBeenCalled();
    expect(metrics.recordAlertOutcome).toHaveBeenCalledWith(
      'HighOfDayAlert',
      'skipped_model_hold',
    );
  });

  it('el gate async tambien respeta la serializacion de la queue', async () => {
    const feed = new FakeFeed();
    const order: string[] = [];
    let releaseFirstGate: () => void = () => {};
    const firstGateHold: Promise<void> = new Promise((r) => {
      releaseFirstGate = r;
    });
    let firstSnapshotStarted: () => void = () => {};
    const firstSnapshotPromise: Promise<void> = new Promise((r) => {
      firstSnapshotStarted = r;
    });

    let snapshotCalls = 0;
    type Snap = { decision: 'buy' };
    const slowModel: DecisionModel<Snap> = {
      name: 'SlowGate',
      async buildSnapshot() {
        snapshotCalls += 1;
        const localCall = snapshotCalls;
        order.push(`buildSnapshot:${localCall}`);
        if (localCall === 1) {
          firstSnapshotStarted();
          await firstGateHold;
        }
        order.push(`buildSnapshotEnd:${localCall}`);
        return { decision: 'buy' };
      },
      evaluate(snapshot) {
        return {
          action: 'buy',
          symbol: '',
          side: 'BUY',
          entryLimitPrice: 0,
          quantity: 0,
          stopOffset: 0,
          takeProfitOffset: 0,
          checks: [{ name: 'gate', passed: true }],
          snapshot,
        };
      },
    };

    const handle = vi.fn(async (symbol: string) => {
      order.push(`handle:${symbol}`);
    });
    const onAlert = { handle } as unknown as OnScannerAlert;
    const strategyWithModel: EventStrategy = {
      ...strategy,
      model: slowModel as DecisionModel,
    };
    const mgr = new AlertEventManager({
      feed,
      strategy: strategyWithModel,
      onAlert,
      metrics: makeMetrics(),
    });
    await mgr.start();

    feed.emit('cfg-A', 'AAPL');
    feed.emit('cfg-A', 'MSFT');

    await firstSnapshotPromise;
    expect(order).toEqual(['buildSnapshot:1']);
    releaseFirstGate();

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toEqual([
      'buildSnapshot:1',
      'buildSnapshotEnd:1',
      'handle:AAPL',
      'buildSnapshot:2',
      'buildSnapshotEnd:2',
      'handle:MSFT',
    ]);
  });
});
