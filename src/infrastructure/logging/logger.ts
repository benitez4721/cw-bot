import pino from 'pino';
import { env } from '../config/env.js';

const isDev = env.NODE_ENV === 'development';
const hasLogtail = Boolean(env.LOGTAIL_SOURCE_TOKEN);
const level = env.LOG_LEVEL ?? 'info';

interface TransportTarget {
  target: string;
  level?: string;
  options?: Record<string, unknown>;
}

function buildTargets(): TransportTarget[] | null {
  if (!hasLogtail && !isDev) return null;

  const targets: TransportTarget[] = [];
  if (hasLogtail) {
    targets.push({
      target: '@logtail/pino',
      level,
      options: { sourceToken: env.LOGTAIL_SOURCE_TOKEN },
    });
  }
  if (isDev) {
    targets.push({
      target: 'pino-pretty',
      level,
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
    });
  } else if (hasLogtail) {
    targets.push({
      target: 'pino/file',
      level,
      options: { destination: 1 },
    });
  }
  return targets;
}

const targets = buildTargets();

export const logger = pino({
  level,
  base: { app: 'cw-bot' },
  transport: targets ? { targets } : undefined,
});
