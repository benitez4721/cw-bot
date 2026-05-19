import type { MarketHours } from '../../domain/market/MarketHours.js';

const TIME_ZONE = 'America/New_York';
const OPEN_MINUTES = 9 * 60 + 30;
// 15:50 ET — bot stops trading 10 min before the RTH close so that
// MarketCloseManager can flatten remaining positions before 16:00.
const CLOSE_MINUTES = 15 * 60 + 50;

const formatter = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hour12: false,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

export class UsMarketHoursAdapter implements MarketHours {
  isOpen(at: Date): boolean {
    const parts = formatter.formatToParts(at);
    const weekday = parts.find((p) => p.type === 'weekday')?.value;
    const hour = parts.find((p) => p.type === 'hour')?.value;
    const minute = parts.find((p) => p.type === 'minute')?.value;

    if (!weekday || !hour || !minute) return false;
    if (weekday === 'Sat' || weekday === 'Sun') return false;

    const minutesOfDay = Number(hour) * 60 + Number(minute);
    return minutesOfDay >= OPEN_MINUTES && minutesOfDay < CLOSE_MINUTES;
  }
}
