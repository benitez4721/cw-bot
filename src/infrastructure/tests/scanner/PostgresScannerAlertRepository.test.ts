import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { ScannerAlertRecord } from '../../../domain/scanner/ScannerTypes.js';
import { PostgresScannerAlertRepository } from '../../scanner/PostgresScannerAlertRepository.js';

function makePool() {
  const query =
    vi.fn<(sql: string, params: unknown[]) => Promise<{ rows: unknown[] }>>();
  query.mockResolvedValue({ rows: [] });
  const pool = { query } as unknown as Pool;
  return { pool, query };
}

const record: ScannerAlertRecord = {
  configId: 'cfg-A',
  capturedAt: '2026-05-30T14:31:00.000Z',
  row: {
    symbol: 'AAPL',
    columns: [
      { key: 'Price', value: '5.23' },
      { key: 'RVOL', value: '7.1' },
    ],
  },
};

describe('PostgresScannerAlertRepository', () => {
  it('append inserta config_id, symbol, columns jsonb y captured_at en orden', async () => {
    const { pool, query } = makePool();
    const repo = new PostgresScannerAlertRepository(pool);

    await repo.append(record);

    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO scanner_alerts');
    expect(sql).toContain('(config_id, symbol, columns, captured_at)');
    expect(sql).toContain('$3::jsonb');
    expect(params).toEqual([
      'cfg-A',
      'AAPL',
      JSON.stringify(record.row.columns),
      '2026-05-30T14:31:00.000Z',
    ]);
  });

  it('respeta el tableName custom de las options', async () => {
    const { pool, query } = makePool();
    const repo = new PostgresScannerAlertRepository(pool, {
      tableName: 'scanner_alerts_test',
    });

    await repo.append(record);

    const [sql] = query.mock.calls[0];
    expect(sql).toContain('INSERT INTO scanner_alerts_test');
  });
});
