import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventStrategy } from '../../../domain/decision/EventStrategy.js';
import type { MetricsPort } from '../../../domain/metrics/MetricsPort.js';
import type { ScannerFeedPort } from '../../../domain/scanner/ScannerFeedPort.js';
import type { ScannerRow } from '../../../domain/scanner/ScannerTypes.js';
import { AlertEventManager } from '../../scanner/AlertEventManager.js';
import type { OnScannerAlert } from '../../scanner/OnScannerAlert.js';

const strategy: EventStrategy = {
  name: 'HighOfDayAlert',
  cwConfigId: 'cfg-A',
  quantity: 2000,
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

  emit(configId: string, symbol: string): void {
    this.alertCb?.(configId, { symbol, columns: [] });
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
