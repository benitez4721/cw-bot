import type { DecisionStrategy } from '../../domain/decision/DecisionStrategy.js';
import type { MarketHours, Session } from '../../domain/market/MarketHours.js';
import type { BarRepository } from '../../domain/marketdata/BarRepository.js';
import type { HistoricalBarsPort } from '../../domain/marketdata/HistoricalBarsPort.js';
import type { Bar } from '../../domain/marketdata/MarketDataTypes.js';
import type { MarketFeedPort } from '../../domain/marketdata/MarketFeedPort.js';
import type { MetricsPort } from '../../domain/metrics/MetricsPort.js';
import type { TradeContextRepository } from '../../domain/trade/TradeContextRepository.js';
import { logger } from '../../infrastructure/logging/logger.js';
import { errMsg } from '../../shared/errors.js';
import type { FlattenAllPositions } from '../broker/FlattenAllPositions.js';
import type { FlattenPrePositions } from '../broker/FlattenPrePositions.js';
import type { PlaceBracketOrder } from '../broker/PlaceBracketOrder.js';
import type { PlaceLimitOrder } from '../broker/PlaceLimitOrder.js';
import type { CheckOpenTrades } from '../trade/CheckOpenTrades.js';
import type { CheckSyntheticStops } from '../trade/CheckSyntheticStops.js';
import type { MaybeMoveStopToBreakEven } from '../trade/MaybeMoveStopToBreakEven.js';
import type { MaybeTrailStopAlongEma } from '../trade/MaybeTrailStopAlongEma.js';
import type { MaybeTrailSyntheticStop } from '../trade/MaybeTrailSyntheticStop.js';
import type { ReconcileEntryFill } from '../trade/ReconcileEntryFill.js';
import type { RecordTradeContext } from '../trade/RecordTradeContext.js';
import { SessionBoundaryRunner } from './SessionBoundaryRunner.js';
import { StrategyEvaluator } from './StrategyEvaluator.js';
import { SymbolSubscriptionService } from './SymbolSubscriptionService.js';

const log = logger.child({ component: 'BarStreamManager' });

const DEFAULT_SYNC_INTERVAL_MS = 10_000;

export type BarStreamManagerStatus = 'idle' | 'running';

export interface BarStreamManagerOptions {
  feed: MarketFeedPort;
  historicalBars: HistoricalBarsPort;
  barRepo: BarRepository;
  strategies: DecisionStrategy[];
  placeBracketOrder: PlaceBracketOrder;
  recordTradeContext: RecordTradeContext;
  reconcileEntryFill: ReconcileEntryFill;
  checkOpenTrades: CheckOpenTrades;
  maybeMoveStopToBreakEven?: MaybeMoveStopToBreakEven;
  marketHours: MarketHours;
  metrics: MetricsPort;
  // Disparado una sola vez al detectarse la transición rth → closed
  // (15:50 ET con UsMarketHoursAdapter). Opcional para tests legacy.
  flattenAll?: FlattenAllPositions;
  // Disparado una sola vez al detectarse la transición pre → transition
  // (9:20 ET con UsMarketHoursAdapter). Cierra las posiciones pre con Limit
  // cross-the-spread antes de que arranque RTH. Opcional para tests legacy.
  flattenPrePositions?: FlattenPrePositions;
  // Usado en el branch pre de processStrategy. Opcional para tests legacy y
  // entornos solo-RTH (DECISION_ENABLED apagado en pre).
  placeLimitOrder?: PlaceLimitOrder;
  checkSyntheticStops?: CheckSyntheticStops;
  // Trailing stop sintetico para ctx pre con trailingStopPercent. Invocado
  // antes de checkSyntheticStops para que el cross-check use el stop ya
  // actualizado.
  maybeTrailSyntheticStop?: MaybeTrailSyntheticStop;
  // Trail por EMA para ctx con emaTrailPeriod/emaTrailBufferBps (EventStrategy
  // HighOfDayAlertEmaTrail). Corre en pre + rth, antes de checkSyntheticStops
  // en pre. En rth ademas mueve el StopMarket del broker via replaceStopPrice.
  maybeTrailStopAlongEma?: MaybeTrailStopAlongEma;
  // Trade repo: ademas de las watchlists de las DecisionStrategy, los simbolos
  // de los trades activos (EventStrategy incluidos) se suman al set suscrito
  // para que el manager reciba sus barras. Sin esto, los trades de event no
  // tendrian feed a menos que coincidieran con la watchlist de algun modelo.
  tradeRepo?: TradeContextRepository;
  // Disparado una sola vez por día NY cuando el tick cae dentro de la
  // ventana 9:29 ET de un día hábil. Bot arranca el día con Redis limpio.
  flushRedis?: () => Promise<void>;
  bootstrapBars?: number;
  syncIntervalMs?: number;
  // Injected for tests
  now?: () => number;
  schedule?: (cb: () => void, ms: number) => NodeJS.Timeout;
  cancel?: (handle: NodeJS.Timeout) => void;
}

// Event-driven runtime: subscribes to the realtime feed, keeps the bar cache
// fresh, and triggers each strategy's evaluation on every AM bar close.
// Symbols are added/removed by polling the union of strategy watchlists on a
// fixed interval. Each strategy carries its own watchlist and order config;
// exposure is tracked per (model, symbol) via the trade context repo.
//
// Orquesta tres colaboradores: SessionBoundaryRunner (jobs por boundary de
// sesión), SymbolSubscriptionService (suscripción + cache de barras) y
// StrategyEvaluator (decisión + colocación). Acá solo viven el tick-loop, el
// wiring del feed y los getters de health.
export class BarStreamManager {
  private readonly feed: MarketFeedPort;
  private readonly strategies: DecisionStrategy[];
  private readonly marketHours: MarketHours;
  private readonly metrics: MetricsPort;
  private readonly sessionBoundaries: SessionBoundaryRunner;
  private readonly subscriptions: SymbolSubscriptionService;
  private readonly evaluator: StrategyEvaluator;
  // Sesion vista en el tick anterior. Sirve para detectar boundaries
  // (pre→transition, rth→closed) sin depender del estado del feed.
  private lastSession: Session | null = null;
  private readonly syncIntervalMs: number;
  private readonly now: () => number;
  private readonly schedule: (cb: () => void, ms: number) => NodeJS.Timeout;
  private readonly cancel: (handle: NodeJS.Timeout) => void;

  private tickTimer: NodeJS.Timeout | null = null;
  private status: BarStreamManagerStatus = 'idle';
  private handlersRegistered = false;
  private lastSuccessfulTick = 0;
  private feedConnected = false;

  constructor(options: BarStreamManagerOptions) {
    this.feed = options.feed;
    this.strategies = options.strategies;
    this.marketHours = options.marketHours;
    this.metrics = options.metrics;
    this.syncIntervalMs = options.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    this.now = options.now ?? (() => Date.now());
    this.schedule = options.schedule ?? ((cb, ms) => setTimeout(cb, ms));
    this.cancel = options.cancel ?? ((h) => clearTimeout(h));
    this.sessionBoundaries = new SessionBoundaryRunner({
      flattenAll: options.flattenAll,
      flattenPrePositions: options.flattenPrePositions,
      flushRedis: options.flushRedis,
    });
    this.subscriptions = new SymbolSubscriptionService({
      feed: options.feed,
      historicalBars: options.historicalBars,
      barRepo: options.barRepo,
      strategies: options.strategies,
      metrics: options.metrics,
      tradeRepo: options.tradeRepo,
      bootstrapBars: options.bootstrapBars,
      now: this.now,
    });
    this.evaluator = new StrategyEvaluator({
      strategies: options.strategies,
      placeBracketOrder: options.placeBracketOrder,
      recordTradeContext: options.recordTradeContext,
      reconcileEntryFill: options.reconcileEntryFill,
      checkOpenTrades: options.checkOpenTrades,
      maybeMoveStopToBreakEven: options.maybeMoveStopToBreakEven,
      marketHours: options.marketHours,
      metrics: options.metrics,
      placeLimitOrder: options.placeLimitOrder,
      checkSyntheticStops: options.checkSyntheticStops,
      maybeTrailSyntheticStop: options.maybeTrailSyntheticStop,
      maybeTrailStopAlongEma: options.maybeTrailStopAlongEma,
      now: this.now,
      recoverCache: (symbol) => void this.subscriptions.recoverCache(symbol),
    });
  }

  getStatus(): BarStreamManagerStatus {
    return this.status;
  }

  lastSuccessfulTickAt(): number {
    return this.lastSuccessfulTick;
  }

  subscribedCount(): number {
    return this.subscriptions.subscribedCount();
  }

  async forceSync(): Promise<void> {
    return this.tick();
  }

  async start(): Promise<void> {
    if (this.status === 'running') return;

    if (!this.handlersRegistered) {
      this.feed.onBar((symbol, bar) => {
        void this.handleBar(symbol, bar).catch((err) => {
          log.error(
            { symbol, err: errMsg(err) },
            'handleBar failed unexpectedly',
          );
        });
      });
      this.feed.onConnectionChange((connected) => {
        log.info({ connected }, 'feed connection');
        this.metrics.setMarketFeedConnected(connected);
      });
      this.handlersRegistered = true;
    }

    this.status = 'running';
    await this.tick();
    this.scheduleNextTick();
    log.info(
      {
        subscribed: this.subscriptions.subscribedCount(),
        marketOpen: this.feedConnected,
        strategies: this.strategies.map((s) => s.name),
      },
      'started',
    );
  }

  stop(): void {
    if (this.status === 'idle') return;
    this.status = 'idle';
    if (this.tickTimer) {
      this.cancel(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.feedConnected) {
      this.feed.disconnect();
      this.feedConnected = false;
    }
    this.subscriptions.clear();
    this.evaluator.clear();
  }

  private scheduleNextTick(): void {
    if (this.status !== 'running') return;
    this.tickTimer = this.schedule(() => {
      this.tickTimer = null;
      void this.tick()
        .catch((err) => {
          log.error({ err: errMsg(err) }, 'tick failed');
        })
        .finally(() => this.scheduleNextTick());
    }, this.syncIntervalMs);
  }

  private async tick(): Promise<void> {
    const nowDate = new Date(this.now());
    await this.sessionBoundaries.triggerPreMarketFlush(nowDate);
    const session = this.marketHours.session(nowDate);
    const connected = this.marketHours.isConnected(nowDate);

    // Boundary pre → transition (9:20 ET): flatten posiciones pre antes de
    // RTH. Lo evaluamos antes de tocar feed/sync para que el flatten arranque
    // aunque haya un connect fail en este mismo tick.
    if (this.lastSession === 'pre' && session === 'transition') {
      this.sessionBoundaries.triggerPreFlatten(nowDate);
    }

    this.lastSession = session;

    if (connected && !this.feedConnected) {
      log.info({ session }, 'market connected — connecting feed');
      try {
        await this.feed.connect();
        this.feedConnected = true;
      } catch (err) {
        log.error(
          { err: errMsg(err) },
          'feed connect failed — will retry on next tick',
        );
        return;
      }
      await this.subscriptions.syncWatchlist();
      return;
    }

    if (!connected && this.feedConnected) {
      log.info('market closed — disconnecting feed');
      this.feed.disconnect();
      this.feedConnected = false;
      this.subscriptions.clear();
      this.evaluator.clear();
      this.sessionBoundaries.triggerRthFlatten(nowDate);
      return;
    }

    if (connected && this.feedConnected) {
      await this.subscriptions.syncWatchlist();
    }
  }

  private async handleBar(symbol: string, bar: Bar): Promise<void> {
    const shouldEvaluate = await this.subscriptions.ingestBar(symbol, bar);
    if (!shouldEvaluate) return;
    await this.evaluator.processSymbol(symbol, bar);
    this.lastSuccessfulTick = this.now();
  }
}
