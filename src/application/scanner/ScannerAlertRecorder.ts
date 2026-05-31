import type { ScannerAlertRepository } from '../../domain/scanner/ScannerAlertRepository.js';
import type { ScannerFeedPort } from '../../domain/scanner/ScannerFeedPort.js';
import type { ScannerRow } from '../../domain/scanner/ScannerTypes.js';
import { logger } from '../../infrastructure/logging/logger.js';

const log = logger.child({ component: 'ScannerAlertRecorder' });

export interface ScannerAlertRecorderDeps {
  feed: ScannerFeedPort;
  repository: ScannerAlertRepository;
  configIds: string[];
  now?: () => string;
}

// Graba cada NewAlert crudo del feed CW en el repositorio, antes de cualquier
// model-gate. Consumidor independiente del feed: corre en paralelo a los
// AlertEventManager sin afectarlos. La captura es best-effort y nunca debe
// frenar ni tumbar el trading.
export class ScannerAlertRecorder {
  private readonly feed: ScannerFeedPort;
  private readonly repository: ScannerAlertRepository;
  private readonly configIds: string[];
  private readonly now: () => string;
  // Serializa los append: un INSERT a la vez, así una ráfaga de alerts no
  // dispara N inserts concurrentes que agoten el pool. Mismo patrón que la
  // queue de AlertEventManager.
  private queue: Promise<void> = Promise.resolve();

  constructor(deps: ScannerAlertRecorderDeps) {
    this.feed = deps.feed;
    this.repository = deps.repository;
    this.configIds = deps.configIds;
    this.now = deps.now ?? (() => new Date().toISOString());

    // Registramos en el constructor (no en start) para que el callback sea
    // estructuralmente único: un doble start() no duplicaría grabaciones.
    this.feed.onAlert((configId, row) => this.record(configId, row));
  }

  async start(): Promise<void> {
    for (const configId of this.configIds) {
      this.feed.subscribeAlert(configId);
    }
    await this.feed.connect();
  }

  private record(configId: string, row: ScannerRow): void {
    if (!this.configIds.includes(configId)) return;
    // capturedAt es ingest-time: CW no manda timestamp en el NewAlert, así que
    // el momento de recepción es lo mejor que tenemos.
    const record = { configId, capturedAt: this.now(), row };
    // Fire-and-forget. Append-only sin dedupe — un alert repetido por CW se
    // graba a propósito (log crudo para backtest). Si Postgres falla, logueamos
    // y seguimos: el trading no debe enterarse.
    this.queue = this.queue
      .then(() => this.repository.append(record))
      .catch((err) => {
        log.warn(
          {
            symbol: row.symbol,
            configId,
            err: err instanceof Error ? err.message : String(err),
          },
          'failed to persist scanner alert',
        );
      });
  }
}
