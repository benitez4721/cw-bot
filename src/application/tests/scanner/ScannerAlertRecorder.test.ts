import { describe, expect, it, vi } from 'vitest';
import type { ScannerAlertRepository } from '../../../domain/scanner/ScannerAlertRepository.js';
import type { ScannerFeedPort } from '../../../domain/scanner/ScannerFeedPort.js';
import type {
  ScannerAlertRecord,
  ScannerColumn,
  ScannerRow,
} from '../../../domain/scanner/ScannerTypes.js';
import { ScannerAlertRecorder } from '../../scanner/ScannerAlertRecorder.js';

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

function makeRepo() {
  const records: ScannerAlertRecord[] = [];
  const append = vi.fn(async (record: ScannerAlertRecord) => {
    records.push(record);
  });
  const repository: ScannerAlertRepository = { append };
  return { repository, records, append };
}

function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('ScannerAlertRecorder', () => {
  it('start se suscribe a cada configId y conecta', async () => {
    const feed = new FakeFeed();
    const { repository } = makeRepo();
    const recorder = new ScannerAlertRecorder({
      feed,
      repository,
      configIds: ['cfg-A', 'cfg-B'],
    });

    await recorder.start();

    expect(feed.subscribedAlertConfigs).toEqual(['cfg-A', 'cfg-B']);
    expect(feed.connectCalls).toBe(1);
  });

  it('graba el alert con configId, capturedAt inyectado y el row crudo', async () => {
    const feed = new FakeFeed();
    const { repository, records } = makeRepo();
    new ScannerAlertRecorder({
      feed,
      repository,
      configIds: ['cfg-A'],
      now: () => '2026-05-30T14:31:00.000Z',
    });

    feed.emit('cfg-A', 'AAPL', [{ key: 'Price', value: '5.23' }]);
    await flush();

    expect(records).toEqual([
      {
        configId: 'cfg-A',
        capturedAt: '2026-05-30T14:31:00.000Z',
        row: { symbol: 'AAPL', columns: [{ key: 'Price', value: '5.23' }] },
      },
    ]);
  });

  it('ignora alerts de configIds fuera del set', async () => {
    const feed = new FakeFeed();
    const { repository, records, append } = makeRepo();
    new ScannerAlertRecorder({ feed, repository, configIds: ['cfg-A'] });

    feed.emit('otro-cfg', 'TSLA');
    await flush();

    expect(records).toHaveLength(0);
    expect(append).not.toHaveBeenCalled();
  });

  it('un append que rechaza no propaga y el siguiente alert se sigue grabando', async () => {
    const feed = new FakeFeed();
    const append = vi.fn<(record: ScannerAlertRecord) => Promise<void>>();
    append
      .mockRejectedValueOnce(new Error('pg down'))
      .mockResolvedValue(undefined);
    const repository: ScannerAlertRepository = { append };
    new ScannerAlertRecorder({ feed, repository, configIds: ['cfg-A'] });

    feed.emit('cfg-A', 'AAPL');
    feed.emit('cfg-A', 'MSFT');
    await flush();
    await flush();

    expect(append).toHaveBeenCalledTimes(2);
  });

  it('serializa los append en orden (el segundo espera al primero)', async () => {
    const feed = new FakeFeed();
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstHold = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const append = vi.fn(async (record: ScannerAlertRecord) => {
      order.push(`start:${record.row.symbol}`);
      if (record.row.symbol === 'AAPL') await firstHold;
      order.push(`end:${record.row.symbol}`);
    });
    const repository: ScannerAlertRepository = { append };
    new ScannerAlertRecorder({ feed, repository, configIds: ['cfg-A'] });

    feed.emit('cfg-A', 'AAPL');
    feed.emit('cfg-A', 'MSFT');
    await flush();
    expect(order).toEqual(['start:AAPL']);

    releaseFirst();
    await flush();
    await flush();
    expect(order).toEqual(['start:AAPL', 'end:AAPL', 'start:MSFT', 'end:MSFT']);
  });
});
