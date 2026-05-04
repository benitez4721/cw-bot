import type { FastifyPluginAsync } from 'fastify';
import type Redis from 'ioredis';
import type { ScannerMonitor } from '../../application/watchlist/ScannerMonitor.js';
import type { MarketHours } from '../../domain/market/MarketHours.js';
import type { TradeStationAdapter } from '../tradestation/TradeStationAdapter.js';

const STALE_SCANNER_MS = 3 * 60 * 1000;
const STALE_TOKEN_MS = 5 * 60 * 1000;
const REDIS_PING_TIMEOUT_MS = 1_000;

export interface HealthRoutesOptions {
  scannerMonitor: ScannerMonitor;
  marketHours: MarketHours;
  redis: Redis | null;
  broker: TradeStationAdapter | null;
  startedAt: number;
}

export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (
  server,
  opts,
) => {
  server.get('/health', { logLevel: 'silent' }, async () => ({
    status: 'ok',
    uptime: process.uptime(),
  }));

  server.get('/health/ready', { logLevel: 'silent' }, async (_req, reply) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    const open = opts.marketHours.isOpen(new Date());

    const scannerStatus = opts.scannerMonitor.getStatus();
    checks.scanner = {
      ok: scannerStatus === 'connected' || scannerStatus === 'disabled',
      detail: scannerStatus,
    };

    if (open && scannerStatus === 'connected') {
      const lastUpdate = opts.scannerMonitor.lastUpdateAt();
      const age = lastUpdate ? Date.now() - lastUpdate : Infinity;
      checks.scanner_freshness = {
        ok: age < STALE_SCANNER_MS,
        detail: lastUpdate ? `${Math.round(age / 1000)}s ago` : 'never',
      };
    }

    if (opts.redis) {
      checks.redis = await pingRedis(opts.redis);
    }

    if (opts.broker && open) {
      const tokenStatus = opts.broker.tokenStatus();
      const tokenAgeOk =
        tokenStatus.cached || Date.now() - opts.startedAt < STALE_TOKEN_MS;
      checks.broker_token = {
        ok: tokenAgeOk,
        detail: tokenStatus.cached
          ? `cached (${Math.round(tokenStatus.expiresInMs / 1000)}s left)`
          : 'no token cached yet',
      };
    }

    const allOk = Object.values(checks).every((c) => c.ok);
    if (!allOk) reply.status(503);
    return { status: allOk ? 'ready' : 'degraded', open, checks };
  });
};

async function pingRedis(
  redis: Redis,
): Promise<{ ok: boolean; detail?: string }> {
  try {
    const result = await Promise.race([
      redis.ping(),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('redis ping timeout')),
          REDIS_PING_TIMEOUT_MS,
        ),
      ),
    ]);
    return { ok: result === 'PONG', detail: result };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
