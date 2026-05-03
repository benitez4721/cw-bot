import type { BrokerPort } from '../../domain/broker/BrokerPort.js';
import type { WatchlistRepository } from '../../domain/watchlist/WatchlistRepository.js';
import type { EvaluateDecision } from './EvaluateDecision.js';
import type { PlaceBracketOrder } from '../broker/PlaceBracketOrder.js';

export type DecisionRunnerStatus = 'idle' | 'running' | 'disabled';

export interface DecisionRunnerOptions {
  evaluate: EvaluateDecision;
  placeBracketOrder: PlaceBracketOrder;
  watchlist: WatchlistRepository;
  broker: BrokerPort;
  intervalMs: number;
  enabled?: boolean;
}

export class DecisionRunner {
  private readonly evaluate: EvaluateDecision;
  private readonly placeBracketOrder: PlaceBracketOrder;
  private readonly watchlist: WatchlistRepository;
  private readonly broker: BrokerPort;
  private readonly intervalMs: number;
  private readonly enabled: boolean;
  private readonly inFlight = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private status: DecisionRunnerStatus;

  constructor(options: DecisionRunnerOptions) {
    this.evaluate = options.evaluate;
    this.placeBracketOrder = options.placeBracketOrder;
    this.watchlist = options.watchlist;
    this.broker = options.broker;
    this.intervalMs = options.intervalMs;
    this.enabled = options.enabled ?? true;
    this.status = this.enabled ? 'idle' : 'disabled';
  }

  start(): void {
    if (!this.enabled) {
      console.log('[DecisionRunner] Disabled by config — skipping loop.');
      return;
    }
    if (this.timer) return;
    this.status = 'running';
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    console.log(`[DecisionRunner] Started — interval=${this.intervalMs}ms`);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.enabled) this.status = 'idle';
  }

  getStatus(): DecisionRunnerStatus {
    return this.status;
  }

  private async tick(): Promise<void> {
    const symbols = this.watchlist
      .list()
      .filter((s) => s.status === 'active')
      .map((s) => s.symbol);

    if (symbols.length === 0) return;

    await Promise.all(symbols.map((symbol) => this.processSymbol(symbol)));
  }

  private async processSymbol(symbol: string): Promise<void> {
    if (this.inFlight.has(symbol)) {
      console.log(`[DecisionRunner] ${symbol} still in-flight — skipping tick`);
      return;
    }
    this.inFlight.add(symbol);
    try {
      if (await this.hasOpenExposure(symbol)) {
        return;
      }
      const signal = await this.evaluate.execute({ symbol });
      if (signal.action !== 'buy') return;

      const result = await this.placeBracketOrder.execute(signal.plan);
      console.log(
        `[DecisionRunner] ${symbol} buy → orderId=${result.orderId} status=${result.status}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(`[DecisionRunner] ${symbol} failed: ${message}`);
    } finally {
      this.inFlight.delete(symbol);
    }
  }

  private async hasOpenExposure(symbol: string): Promise<boolean> {
    const [positions, orders] = await Promise.all([
      this.broker.getPositions(),
      this.broker.getOrders({ symbol }),
    ]);

    if (positions.some((p) => p.symbol === symbol && p.quantity !== 0)) return true;
    return orders.some(
      (o) =>
        o.symbol === symbol &&
        (o.status === 'open' || o.status === 'pending' || o.status === 'partiallyFilled'),
    );
  }
}
