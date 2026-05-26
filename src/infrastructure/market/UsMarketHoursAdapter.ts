import type { MarketHours, Session } from '../../domain/market/MarketHours.js';

const TIME_ZONE = 'America/New_York';
// 6:00 ET — pre-market tradeable abre.
const PRE_OPEN_MINUTES = 6 * 60;
// 9:20 ET — fin de pre-market tradeable. El manager flatea posiciones pre
// antes de cruzar a transition.
const PRE_CLOSE_MINUTES = 9 * 60 + 20;
// 9:30 ET — RTH abre. Entre 9:20 y 9:30 el manager esta idle (transition).
const RTH_OPEN_MINUTES = 9 * 60 + 30;
// 15:50 ET — bot stops trading 10 min before the RTH close so that
// FlattenAllPositions can flatten remaining positions before 16:00.
const RTH_CLOSE_MINUTES = 15 * 60 + 50;

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hour12: false,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export class UsMarketHoursAdapter implements MarketHours {
  session(at: Date): Session {
    const parts = formatter.formatToParts(at);
    const weekday = parts.find((p) => p.type === 'weekday')?.value;
    const hour = parts.find((p) => p.type === 'hour')?.value;
    const minute = parts.find((p) => p.type === 'minute')?.value;

    if (!weekday || !hour || !minute) return 'closed';
    if (weekday === 'Sat' || weekday === 'Sun') return 'closed';

    const minutesOfDay = Number(hour) * 60 + Number(minute);
    if (minutesOfDay >= PRE_OPEN_MINUTES && minutesOfDay < PRE_CLOSE_MINUTES) {
      return 'pre';
    }
    if (minutesOfDay >= PRE_CLOSE_MINUTES && minutesOfDay < RTH_OPEN_MINUTES) {
      return 'transition';
    }
    if (minutesOfDay >= RTH_OPEN_MINUTES && minutesOfDay < RTH_CLOSE_MINUTES) {
      return 'rth';
    }
    return 'closed';
  }

  isOpen(at: Date): boolean {
    return this.session(at) === 'rth';
  }

  isConnected(at: Date): boolean {
    const s = this.session(at);
    return s === 'pre' || s === 'transition' || s === 'rth';
  }
}
