import { describe, expect, it } from 'vitest';
import { UsMarketHoursAdapter } from '../../market/UsMarketHoursAdapter.js';

describe('UsMarketHoursAdapter', () => {
  const market = new UsMarketHoursAdapter();

  it('open during regular session in EST winter', () => {
    // 2026-01-15 (Thursday) 14:30 UTC = 09:30 EST → open boundary
    expect(market.isOpen(new Date('2026-01-15T14:30:00Z'))).toBe(true);
    // 2026-01-15 20:49 UTC = 15:49 EST → still open (last minute the bot trades)
    expect(market.isOpen(new Date('2026-01-15T20:49:00Z'))).toBe(true);
  });

  it('closed before open and after the bot-stop boundary in EST winter', () => {
    // 2026-01-15 14:29 UTC = 09:29 EST → closed (just before open)
    expect(market.isOpen(new Date('2026-01-15T14:29:00Z'))).toBe(false);
    // 2026-01-15 20:50 UTC = 15:50 EST → closed (bot-stop boundary, flatten window starts)
    expect(market.isOpen(new Date('2026-01-15T20:50:00Z'))).toBe(false);
    // 2026-01-15 21:00 UTC = 16:00 EST → still closed (past RTH close)
    expect(market.isOpen(new Date('2026-01-15T21:00:00Z'))).toBe(false);
  });

  it('handles DST transition (EDT summer) correctly', () => {
    // 2026-07-15 (Wednesday) 13:30 UTC = 09:30 EDT → open
    expect(market.isOpen(new Date('2026-07-15T13:30:00Z'))).toBe(true);
    // 2026-07-15 19:50 UTC = 15:50 EDT → closed (bot-stop)
    expect(market.isOpen(new Date('2026-07-15T19:50:00Z'))).toBe(false);
  });

  it('closed on Saturday', () => {
    // 2026-01-17 (Saturday) 15:00 UTC = 10:00 EST
    expect(market.isOpen(new Date('2026-01-17T15:00:00Z'))).toBe(false);
  });

  it('closed on Sunday', () => {
    // 2026-01-18 (Sunday) 15:00 UTC = 10:00 EST
    expect(market.isOpen(new Date('2026-01-18T15:00:00Z'))).toBe(false);
  });
});
