import type { Pool } from 'pg';
import type { ScannerAlertRepository } from '../../domain/scanner/ScannerAlertRepository.js';
import type { ScannerAlertRecord } from '../../domain/scanner/ScannerTypes.js';

export interface PostgresScannerAlertRepositoryOptions {
  tableName?: string;
}

// Append-only log de alertas crudas del scanner. La tabla se crea aparte
// (scripts/init-scanner-alerts.ts); este adapter solo inserta. `columns` se
// guarda como JSONB para preservar las columnas dinámicas tal cual las manda CW.
export class PostgresScannerAlertRepository implements ScannerAlertRepository {
  private readonly pool: Pool;
  private readonly tableName: string;

  constructor(pool: Pool, options: PostgresScannerAlertRepositoryOptions = {}) {
    this.pool = pool;
    this.tableName = options.tableName ?? 'scanner_alerts';
  }

  async append(record: ScannerAlertRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.tableName} (config_id, symbol, columns, captured_at) VALUES ($1, $2, $3::jsonb, $4)`,
      [
        record.configId,
        record.row.symbol,
        JSON.stringify(record.row.columns),
        record.capturedAt,
      ],
    );
  }
}
