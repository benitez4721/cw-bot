import { logger } from '../../infrastructure/logging/logger.js';
import { errMsg } from '../../shared/errors.js';
import type { FlattenAllPositions } from '../broker/FlattenAllPositions.js';
import type { FlattenPrePositions } from '../broker/FlattenPrePositions.js';

const log = logger.child({ component: 'SessionBoundaryRunner' });

const dayKeyFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

// Flush corre 1 min antes del pre-market open (3:59 ET) de cada día hábil
// para que el bot arranque el día con Redis limpio.
const FLUSH_HOUR_NY = 3;
const FLUSH_MINUTE_NY = 59;

const wallNyFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour12: false,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

function isPreMarketFlushWindow(now: Date): boolean {
  const parts = wallNyFormatter.formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  const hour = parts.find((p) => p.type === 'hour')?.value;
  const minute = parts.find((p) => p.type === 'minute')?.value;
  if (!weekday || !hour || !minute) return false;
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return Number(hour) === FLUSH_HOUR_NY && Number(minute) === FLUSH_MINUTE_NY;
}

export interface SessionBoundaryRunnerOptions {
  // Disparado una sola vez al detectarse la transición rth → closed
  // (15:50 ET con UsMarketHoursAdapter). Opcional para tests legacy.
  flattenAll?: FlattenAllPositions;
  // Disparado una sola vez al detectarse la transición pre → transition
  // (9:20 ET con UsMarketHoursAdapter). Cierra las posiciones pre con Limit
  // cross-the-spread antes de que arranque RTH. Opcional para tests legacy.
  flattenPrePositions?: FlattenPrePositions;
  // Disparado una sola vez por día NY cuando el tick cae dentro de la
  // ventana 3:59 ET de un día hábil. Bot arranca el día con Redis limpio.
  flushRedis?: () => Promise<void>;
}

// Jobs idempotentes por día NY disparados en los boundaries de sesión. El
// BarStreamManager los invoca desde su tick-loop; cada job corre a lo sumo
// una vez por día calendario (TZ NY) aunque el tick los reevalúe.
export class SessionBoundaryRunner {
  private readonly flattenAll?: FlattenAllPositions;
  private readonly flattenPrePositions?: FlattenPrePositions;
  private readonly flushRedis?: () => Promise<void>;
  private lastFlattenedDay: string | null = null;
  private lastPreFlattenedDay: string | null = null;
  private lastFlushedDay: string | null = null;

  constructor(options: SessionBoundaryRunnerOptions) {
    this.flattenAll = options.flattenAll;
    this.flattenPrePositions = options.flattenPrePositions;
    this.flushRedis = options.flushRedis;
  }

  // Fire-and-forget: el tick sigue su curso aunque el flatten tarde varios
  // segundos. Idempotencia diaria via `lastFlattenedDay` en TZ NY — sólo
  // un disparo por día calendario (sirve para evitar redisparos si el feed
  // re-conecta brevemente y vuelve a desconectarse).
  triggerRthFlatten(now: Date): void {
    if (!this.flattenAll) return;
    const day = dayKeyFormatter.format(now);
    if (this.lastFlattenedDay === day) return;
    this.lastFlattenedDay = day;
    log.info({ day }, 'market closed — running flatten');
    void this.flattenAll.execute().catch((err) => {
      log.error({ err: errMsg(err) }, 'flatten execution failed');
    });
  }

  // Idempotente por día NY: marcamos lastPreFlattenedDay aunque el flatten
  // falle, para evitar bucles en la ventana de 1 min entre pre y transition.
  // Fire-and-forget para no bloquear el tick.
  triggerPreFlatten(now: Date): void {
    if (!this.flattenPrePositions) return;
    const day = dayKeyFormatter.format(now);
    if (this.lastPreFlattenedDay === day) return;
    this.lastPreFlattenedDay = day;
    log.info({ day }, 'pre → transition — running pre flatten');
    void this.flattenPrePositions.execute().catch((err) => {
      log.error({ err: errMsg(err) }, 'pre flatten execution failed');
    });
  }

  // Awaited: queremos que el flush termine antes de que el tick avance a
  // sus ramas de feed/sync. En la práctica corre a 3:59 ET cuando feed está
  // desconectado, así que no compite con el bootstrap (que ocurre a 4:00).
  // Idempotente por día NY: marcamos el día como flusheado-intentado aunque
  // el flush falle, para evitar bucles de reintento dentro de la ventana.
  async triggerPreMarketFlush(now: Date): Promise<void> {
    if (!this.flushRedis) return;
    if (!isPreMarketFlushWindow(now)) return;
    const day = dayKeyFormatter.format(now);
    if (this.lastFlushedDay === day) return;
    this.lastFlushedDay = day;
    log.info({ day }, 'pre-market window — flushing redis');
    try {
      await this.flushRedis();
    } catch (err) {
      log.error({ err: errMsg(err) }, 'redis flush failed');
    }
  }
}
