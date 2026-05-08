import { describe, expect, it } from 'vitest';
import { UsMarketHoursAdapter } from './UsMarketHoursAdapter.js';

describe('UsMarketHoursAdapter', () => {
  const market = new UsMarketHoursAdapter();

  it('open during regular session in EST winter', () => {
    // 2026-01-15 (Thursday) 14:30 UTC = 09:30 EST → open boundary
    expect(market.isOpen(new Date('2026-01-15T14:30:00Z'))).toBe(true);
    // 2026-01-15 20:59 UTC = 15:59 EST → still open
    expect(market.isOpen(new Date('2026-01-15T20:59:00Z'))).toBe(true);
  });

  it('closed before open and after close in EST winter', () => {
    // 2026-01-15 14:29 UTC = 09:29 EST → closed
    expect(market.isOpen(new Date('2026-01-15T14:29:00Z'))).toBe(false);
    // 2026-01-15 21:00 UTC = 16:00 EST → closed (boundary)
    expect(market.isOpen(new Date('2026-01-15T21:00:00Z'))).toBe(false);
  });

  it('handles DST transition (EDT summer) correctly', () => {
    // 2026-07-15 (Wednesday) 13:30 UTC = 09:30 EDT → open
    expect(market.isOpen(new Date('2026-07-15T13:30:00Z'))).toBe(true);
    // 2026-07-15 20:00 UTC = 16:00 EDT → closed
    expect(market.isOpen(new Date('2026-07-15T20:00:00Z'))).toBe(false);
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
