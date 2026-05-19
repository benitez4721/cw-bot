import type { EventStrategy } from '../../domain/decision/EventStrategy.js';
import type { MetricsPort } from '../../domain/metrics/MetricsPort.js';
import type { ScannerFeedPort } from '../../domain/scanner/ScannerFeedPort.js';
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
  // primero haya persistido (o rechazado).
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
      this.enqueue(row.symbol);
    });
    this.feed.subscribeAlert(this.strategy.cwConfigId);
    await this.feed.connect();
  }

  private enqueue(symbol: string): void {
    this.metrics.recordAlertOutcome(this.strategy.name, 'received');
    this.queue = this.queue
      .then(() => this.onAlert.handle(symbol))
      .catch((err) => {
        log.error(
          {
            model: this.strategy.name,
            symbol,
            err: err instanceof Error ? err.message : String(err),
          },
          'alert handle failed',
        );
      });
  }
}
