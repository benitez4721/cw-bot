import type { FastifyInstance } from 'fastify';
import type { GetEMA } from '../../application/indicators/GetEMA.js';
import type { GetMACD } from '../../application/indicators/GetMACD.js';
import type { GetMACDSeries } from '../../application/indicators/GetMACDSeries.js';
import type { GetVWAP } from '../../application/indicators/GetVWAP.js';
import type {
  EMAInput,
  MACDInput,
  MACDSeriesInput,
  VWAPInput,
} from '../../domain/indicators/IndicatorPort.js';
import type {
  IndicatorInterval,
  IntradayInterval,
  SeriesType,
} from '../../domain/indicators/IndicatorTypes.js';

const VALID_INTERVALS: IndicatorInterval[] = [
  '1min',
  '5min',
  '15min',
  '30min',
  '60min',
  'daily',
  'weekly',
  'monthly',
];
const VALID_VWAP_INTERVALS: IntradayInterval[] = ['1min', '5min', '15min', '30min', '60min'];
const VALID_SERIES_TYPES: SeriesType[] = ['open', 'high', 'low', 'close'];

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return NaN;
  return n;
}

interface EMAQuery {
  symbol?: string;
  interval?: string;
  period?: string;
  seriesType?: string;
}

interface MACDQuery {
  symbol?: string;
  interval?: string;
  seriesType?: string;
  fastPeriod?: string;
  slowPeriod?: string;
  signalPeriod?: string;
}

interface MACDSeriesQuery extends MACDQuery {
  limit?: string;
}

interface VWAPQuery {
  symbol?: string;
  interval?: string;
}

function validateEMAQuery(
  q: EMAQuery,
): { ok: true; input: EMAInput } | { ok: false; error: string } {
  if (!q.symbol) return { ok: false, error: 'symbol is required' };
  if (!q.interval || !VALID_INTERVALS.includes(q.interval as IndicatorInterval)) {
    return { ok: false, error: `interval must be one of: ${VALID_INTERVALS.join(', ')}` };
  }
  const period = parsePositiveInt(q.period);
  if (period === undefined || Number.isNaN(period)) {
    return { ok: false, error: 'period is required and must be a positive integer' };
  }
  if (q.seriesType !== undefined && !VALID_SERIES_TYPES.includes(q.seriesType as SeriesType)) {
    return { ok: false, error: `seriesType must be one of: ${VALID_SERIES_TYPES.join(', ')}` };
  }
  return {
    ok: true,
    input: {
      symbol: q.symbol,
      interval: q.interval as IndicatorInterval,
      period,
      seriesType: q.seriesType as SeriesType | undefined,
    },
  };
}

function validateMACDQuery(
  q: MACDQuery,
): { ok: true; input: MACDInput } | { ok: false; error: string } {
  if (!q.symbol) return { ok: false, error: 'symbol is required' };
  if (!q.interval || !VALID_INTERVALS.includes(q.interval as IndicatorInterval)) {
    return { ok: false, error: `interval must be one of: ${VALID_INTERVALS.join(', ')}` };
  }
  if (q.seriesType !== undefined && !VALID_SERIES_TYPES.includes(q.seriesType as SeriesType)) {
    return { ok: false, error: `seriesType must be one of: ${VALID_SERIES_TYPES.join(', ')}` };
  }
  const fastPeriod = parsePositiveInt(q.fastPeriod);
  if (Number.isNaN(fastPeriod)) return { ok: false, error: 'fastPeriod must be a positive integer' };
  const slowPeriod = parsePositiveInt(q.slowPeriod);
  if (Number.isNaN(slowPeriod)) return { ok: false, error: 'slowPeriod must be a positive integer' };
  const signalPeriod = parsePositiveInt(q.signalPeriod);
  if (Number.isNaN(signalPeriod)) {
    return { ok: false, error: 'signalPeriod must be a positive integer' };
  }
  return {
    ok: true,
    input: {
      symbol: q.symbol,
      interval: q.interval as IndicatorInterval,
      seriesType: q.seriesType as SeriesType | undefined,
      fastPeriod,
      slowPeriod,
      signalPeriod,
    },
  };
}

function validateMACDSeriesQuery(
  q: MACDSeriesQuery,
): { ok: true; input: MACDSeriesInput } | { ok: false; error: string } {
  const base = validateMACDQuery(q);
  if (!base.ok) return base;
  const limit = parsePositiveInt(q.limit);
  if (limit === undefined || Number.isNaN(limit)) {
    return { ok: false, error: 'limit is required and must be a positive integer' };
  }
  return { ok: true, input: { ...base.input, limit } };
}

function validateVWAPQuery(
  q: VWAPQuery,
): { ok: true; input: VWAPInput } | { ok: false; error: string } {
  if (!q.symbol) return { ok: false, error: 'symbol is required' };
  if (!q.interval || !VALID_VWAP_INTERVALS.includes(q.interval as IntradayInterval)) {
    return { ok: false, error: `interval must be one of: ${VALID_VWAP_INTERVALS.join(', ')}` };
  }
  return {
    ok: true,
    input: {
      symbol: q.symbol,
      interval: q.interval as IntradayInterval,
    },
  };
}

export function registerIndicatorRoutes({
  server,
  getEMA,
  getMACD,
  getMACDSeries,
  getVWAP,
}: {
  server: FastifyInstance;
  getEMA: GetEMA;
  getMACD: GetMACD;
  getMACDSeries: GetMACDSeries;
  getVWAP: GetVWAP;
}) {
  server.get<{ Querystring: EMAQuery }>('/api/indicators/ema', async (request, reply) => {
    const validation = validateEMAQuery(request.query ?? {});
    if (!validation.ok) {
      return reply.status(400).send({ error: validation.error });
    }
    try {
      const result = await getEMA.execute(validation.input);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(500).send({ error: message });
    }
  });

  server.get<{ Querystring: MACDQuery }>('/api/indicators/macd', async (request, reply) => {
    const validation = validateMACDQuery(request.query ?? {});
    if (!validation.ok) {
      return reply.status(400).send({ error: validation.error });
    }
    try {
      const result = await getMACD.execute(validation.input);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(500).send({ error: message });
    }
  });

  server.get<{ Querystring: MACDSeriesQuery }>(
    '/api/indicators/macd-series',
    async (request, reply) => {
      const validation = validateMACDSeriesQuery(request.query ?? {});
      if (!validation.ok) {
        return reply.status(400).send({ error: validation.error });
      }
      try {
        const result = await getMACDSeries.execute(validation.input);
        return { series: result };
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        return reply.status(500).send({ error: message });
      }
    },
  );

  server.get<{ Querystring: VWAPQuery }>('/api/indicators/vwap', async (request, reply) => {
    const validation = validateVWAPQuery(request.query ?? {});
    if (!validation.ok) {
      return reply.status(400).send({ error: validation.error });
    }
    try {
      const result = await getVWAP.execute(validation.input);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return reply.status(500).send({ error: message });
    }
  });
}
