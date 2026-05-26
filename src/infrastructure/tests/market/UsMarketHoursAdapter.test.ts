import { describe, expect, it } from 'vitest';
import { UsMarketHoursAdapter } from '../../market/UsMarketHoursAdapter.js';

describe('UsMarketHoursAdapter.session', () => {
  const market = new UsMarketHoursAdapter();

  it('returns "pre" between 6:00 and 9:20 ET in EST winter', () => {
    // 2026-01-15 (Thursday) 11:00 UTC = 06:00 EST → pre open boundary
    expect(market.session(new Date('2026-01-15T11:00:00Z'))).toBe('pre');
    // 2026-01-15 14:19 UTC = 09:19 EST → last minute of pre
    expect(market.session(new Date('2026-01-15T14:19:00Z'))).toBe('pre');
  });

  it('returns "transition" between 9:20 and 9:30 ET in EST winter', () => {
    // 2026-01-15 14:20 UTC = 09:20 EST → transition start
    expect(market.session(new Date('2026-01-15T14:20:00Z'))).toBe('transition');
    // 2026-01-15 14:29 UTC = 09:29 EST → last minute of transition
    expect(market.session(new Date('2026-01-15T14:29:00Z'))).toBe('transition');
  });

  it('returns "rth" between 9:30 and 15:50 ET in EST winter', () => {
    // 2026-01-15 14:30 UTC = 09:30 EST → RTH open boundary
    expect(market.session(new Date('2026-01-15T14:30:00Z'))).toBe('rth');
    // 2026-01-15 20:49 UTC = 15:49 EST → still RTH (last minute the bot trades)
    expect(market.session(new Date('2026-01-15T20:49:00Z'))).toBe('rth');
  });

  it('returns "closed" outside the tradeable window in EST winter', () => {
    // 2026-01-15 10:59 UTC = 05:59 EST → too early
    expect(market.session(new Date('2026-01-15T10:59:00Z'))).toBe('closed');
    // 2026-01-15 20:50 UTC = 15:50 EST → bot-stop boundary
    expect(market.session(new Date('2026-01-15T20:50:00Z'))).toBe('closed');
    // 2026-01-15 21:00 UTC = 16:00 EST → past RTH close
    expect(market.session(new Date('2026-01-15T21:00:00Z'))).toBe('closed');
  });

  it('handles DST transition (EDT summer) correctly', () => {
    // 2026-07-15 (Wednesday) 10:00 UTC = 06:00 EDT → pre open
    expect(market.session(new Date('2026-07-15T10:00:00Z'))).toBe('pre');
    // 2026-07-15 13:20 UTC = 09:20 EDT → transition
    expect(market.session(new Date('2026-07-15T13:20:00Z'))).toBe('transition');
    // 2026-07-15 13:30 UTC = 09:30 EDT → RTH
    expect(market.session(new Date('2026-07-15T13:30:00Z'))).toBe('rth');
    // 2026-07-15 19:50 UTC = 15:50 EDT → closed (bot-stop)
    expect(market.session(new Date('2026-07-15T19:50:00Z'))).toBe('closed');
  });

  it('returns "closed" on weekends', () => {
    // 2026-01-17 (Saturday) 15:00 UTC = 10:00 EST
    expect(market.session(new Date('2026-01-17T15:00:00Z'))).toBe('closed');
    // 2026-01-18 (Sunday) 15:00 UTC = 10:00 EST
    expect(market.session(new Date('2026-01-18T15:00:00Z'))).toBe('closed');
  });
});

describe('UsMarketHoursAdapter.isOpen', () => {
  const market = new UsMarketHoursAdapter();

  it('is true only during RTH (back-compat behavior)', () => {
    // 09:30 EST → RTH starts
    expect(market.isOpen(new Date('2026-01-15T14:30:00Z'))).toBe(true);
    // 15:49 EST → last tradeable RTH minute
    expect(market.isOpen(new Date('2026-01-15T20:49:00Z'))).toBe(true);
  });

  it('is false in pre, transition and post', () => {
    // 07:00 EST → pre
    expect(market.isOpen(new Date('2026-01-15T12:00:00Z'))).toBe(false);
    // 09:25 EST → transition
    expect(market.isOpen(new Date('2026-01-15T14:25:00Z'))).toBe(false);
    // 15:50 EST → closed (bot-stop)
    expect(market.isOpen(new Date('2026-01-15T20:50:00Z'))).toBe(false);
    // 17:00 EST → post-market, but for the bot it's "closed"
    expect(market.isOpen(new Date('2026-01-15T22:00:00Z'))).toBe(false);
  });
});

describe('UsMarketHoursAdapter.isConnected', () => {
  const market = new UsMarketHoursAdapter();

  it('is true throughout pre + transition + rth', () => {
    // 06:00 EST → pre open
    expect(market.isConnected(new Date('2026-01-15T11:00:00Z'))).toBe(true);
    // 09:25 EST → transition
    expect(market.isConnected(new Date('2026-01-15T14:25:00Z'))).toBe(true);
    // 12:00 EST → RTH
    expect(market.isConnected(new Date('2026-01-15T17:00:00Z'))).toBe(true);
    // 15:49 EST → last RTH minute
    expect(market.isConnected(new Date('2026-01-15T20:49:00Z'))).toBe(true);
  });

  it('is false before pre-open, after bot-stop, and on weekends', () => {
    // 05:59 EST → too early
    expect(market.isConnected(new Date('2026-01-15T10:59:00Z'))).toBe(false);
    // 15:50 EST → bot-stop
    expect(market.isConnected(new Date('2026-01-15T20:50:00Z'))).toBe(false);
    // Saturday
    expect(market.isConnected(new Date('2026-01-17T15:00:00Z'))).toBe(false);
  });
});
