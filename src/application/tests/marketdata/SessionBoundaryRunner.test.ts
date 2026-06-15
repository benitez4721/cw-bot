import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlattenAllPositions } from '../../broker/FlattenAllPositions.js';
import type { FlattenPrePositions } from '../../broker/FlattenPrePositions.js';
import { SessionBoundaryRunner } from '../../marketdata/SessionBoundaryRunner.js';

// Fechas de referencia (invierno → EST = UTC-5):
//   08:59 UTC = 03:59 EST  → dentro de la ventana de flush pre-market
//   09:30 UTC = 04:30 EST  → fuera de la ventana
// 2026-01-15 es jueves; 2026-01-17 es sábado.
const FLUSH_WINDOW = new Date('2026-01-15T08:59:00Z');
const OUTSIDE_WINDOW = new Date('2026-01-15T09:30:00Z');
const FLUSH_WINDOW_WEEKEND = new Date('2026-01-17T08:59:00Z');
// Distintos días NY para probar la idempotencia diaria.
const DAY_A = new Date('2026-01-15T20:00:00Z');
const DAY_B = new Date('2026-01-16T20:00:00Z');

function fakeFlatten(): FlattenAllPositions & {
  execute: ReturnType<typeof vi.fn>;
} {
  return { execute: vi.fn(async () => undefined) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SessionBoundaryRunner — triggerRthFlatten', () => {
  it('dispara flattenAll una sola vez por día NY', () => {
    const flattenAll = fakeFlatten();
    const runner = new SessionBoundaryRunner({ flattenAll });

    runner.triggerRthFlatten(DAY_A);
    runner.triggerRthFlatten(DAY_A);
    expect(flattenAll.execute).toHaveBeenCalledTimes(1);

    runner.triggerRthFlatten(DAY_B);
    expect(flattenAll.execute).toHaveBeenCalledTimes(2);
  });

  it('no-op si flattenAll no esta inyectado', () => {
    const runner = new SessionBoundaryRunner({});
    expect(() => runner.triggerRthFlatten(DAY_A)).not.toThrow();
  });
});

describe('SessionBoundaryRunner — triggerPreFlatten', () => {
  it('dispara flattenPrePositions una sola vez por día NY', () => {
    const flattenPrePositions =
      fakeFlatten() as unknown as FlattenPrePositions & {
        execute: ReturnType<typeof vi.fn>;
      };
    const runner = new SessionBoundaryRunner({ flattenPrePositions });

    runner.triggerPreFlatten(DAY_A);
    runner.triggerPreFlatten(DAY_A);
    expect(flattenPrePositions.execute).toHaveBeenCalledTimes(1);

    runner.triggerPreFlatten(DAY_B);
    expect(flattenPrePositions.execute).toHaveBeenCalledTimes(2);
  });
});

describe('SessionBoundaryRunner — triggerPreMarketFlush', () => {
  it('flushea solo dentro de la ventana 3:59 ET y una vez por día', async () => {
    const flushRedis = vi.fn(async () => undefined);
    const runner = new SessionBoundaryRunner({ flushRedis });

    await runner.triggerPreMarketFlush(OUTSIDE_WINDOW);
    expect(flushRedis).not.toHaveBeenCalled();

    await runner.triggerPreMarketFlush(FLUSH_WINDOW);
    await runner.triggerPreMarketFlush(FLUSH_WINDOW);
    expect(flushRedis).toHaveBeenCalledTimes(1);
  });

  it('no flushea en fin de semana aunque sea la hora', async () => {
    const flushRedis = vi.fn(async () => undefined);
    const runner = new SessionBoundaryRunner({ flushRedis });

    await runner.triggerPreMarketFlush(FLUSH_WINDOW_WEEKEND);
    expect(flushRedis).not.toHaveBeenCalled();
  });

  it('si el flush falla, no propaga (no rompe el tick)', async () => {
    const flushRedis = vi.fn(async () => {
      throw new Error('redis down');
    });
    const runner = new SessionBoundaryRunner({ flushRedis });

    await expect(
      runner.triggerPreMarketFlush(FLUSH_WINDOW),
    ).resolves.toBeUndefined();
    expect(flushRedis).toHaveBeenCalledTimes(1);
  });

  it('no-op si flushRedis no esta inyectado', async () => {
    const runner = new SessionBoundaryRunner({});
    await expect(
      runner.triggerPreMarketFlush(FLUSH_WINDOW),
    ).resolves.toBeUndefined();
  });
});
