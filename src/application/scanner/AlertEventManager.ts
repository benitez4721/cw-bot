import type { EventStrategy } from '../../domain/decision/EventStrategy.js';
import type { MetricsPort } from '../../domain/metrics/MetricsPort.js';
import type { ScannerFeedPort } from '../../domain/scanner/ScannerFeedPort.js';
import type { ScannerRow } from '../../domain/scanner/ScannerTypes.js';
import { logger } from '../../infrastructure/logging/logger.js';
import type { OnScannerAlert } from './OnScannerAlert.js';

const log = logger.child({ component: 'AlertEventManager' });

export interface AlertEventManagerDeps {
  feed: ScannerFeedPort;
  strategy: EventStrategy;
  onAlert: OnScannerAlert;
  metrics: MetricsPort;
}

export class AlertEventManager {
  private readonly feed: ScannerFeedPort;
  private readonly strategy: EventStrategy;
  private readonly onAlert: OnScannerAlert;
  private readonly metrics: MetricsPort;
  // Serializa la cadena de handles. Dos NewAlert casi simultáneos no pueden
  // pasar ambos el check del lock por-modelo: el segundo espera a que el
  // primero haya persistido (o rechazado). El gate del modelo (cuando
  // existe) también queda dentro de esta cola para no procesarse en paralelo.
  private queue: Promise<void> = Promise.resolve();

  constructor(deps: AlertEventManagerDeps) {
    this.feed = deps.feed;
    this.strategy = deps.strategy;
    this.onAlert = deps.onAlert;
    this.metrics = deps.metrics;
  }

  async start(): Promise<void> {
    this.feed.onAlert((configId, row) => {
      if (configId !== this.strategy.cwConfigId) return;
      this.metrics.recordAlertOutcome(this.strategy.name, 'received');
      this.queue = this.queue
        .then(() => this.processAlert(row))
        .catch((err) => {
          log.error(
            {
              model: this.strategy.name,
              symbol: row.symbol,
              err: err instanceof Error ? err.message : String(err),
            },
            'alert handle failed',
          );
        });
    });
    this.feed.subscribeAlert(this.strategy.cwConfigId);
    await this.feed.connect();
  }

  private async processAlert(row: ScannerRow): Promise<void> {
    if (!(await this.passesModelGate(row))) return;
    await this.onAlert.handle(row.symbol);
  }

  private async passesModelGate(row: ScannerRow): Promise<boolean> {
    const model = this.strategy.model;
    if (!model) return true;
    const snapshot = await model.buildSnapshot({
      symbol: row.symbol,
      accountId: this.strategy.accountId,
      columns: row.columns,
    });
    const signal = model.evaluate(snapshot);
    if (signal.action === 'hold') {
      this.metrics.recordAlertOutcome(this.strategy.name, 'skipped_model_hold');
      log.info(
        {
          model: this.strategy.name,
          symbol: row.symbol,
          checks: signal.checks,
        },
        'alert skipped — model returned hold',
      );
      return false;
    }
    return true;
  }
}
