import { Pool } from 'pg';

// Crea la tabla + índice del log de alertas del scanner. Idempotente
// (CREATE ... IF NOT EXISTS): re-ejecutable sin efectos. Se corre una vez al
// provisionar. En Render: usar la External Database URL con ?sslmode=require.
const url = process.env.POSTGRES_URL;
if (!url) {
  console.error('POSTGRES_URL no esta seteada en el entorno');
  process.exit(1);
}

const redacted = url.replace(/(:\/\/[^:]+:)[^@]+(@)/, '$1***$2');
console.log(`[init-scanner-alerts] target=${redacted}`);

const pool = new Pool({
  connectionString: url,
  ssl: /sslmode=require/.test(url) ? { rejectUnauthorized: false } : undefined,
});

try {
  await pool.query(
    `CREATE TABLE IF NOT EXISTS scanner_alerts (
      id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      config_id   TEXT        NOT NULL,
      symbol      TEXT        NOT NULL,
      columns     JSONB       NOT NULL,
      captured_at TIMESTAMPTZ NOT NULL
    )`,
  );
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_scanner_alerts_replay
      ON scanner_alerts (config_id, captured_at)`,
  );
  console.log('[init-scanner-alerts] tabla e indice listos (idempotente)');
} catch (err) {
  console.error('[init-scanner-alerts] error:', err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
