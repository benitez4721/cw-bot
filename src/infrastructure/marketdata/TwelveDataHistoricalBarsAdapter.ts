import type {
  FetchHistoricalBarsInput,
  HistoricalBarsPort,
} from '../../domain/marketdata/HistoricalBarsPort.js';
import type { Bar } from '../../domain/marketdata/MarketDataTypes.js';
import type {
  TwelveDataClient,
  TwelveDataValue,
} from '../twelvedata/TwelveDataClient.js';

export class TwelveDataHistoricalBarsAdapter implements HistoricalBarsPort {
  constructor(private readonly client: TwelveDataClient) {}

  // Bootstrap OHLCV series for the LocalIndicatorAdapter path. Twelve Data returns
  // values DESC (most recent first); we reverse to ASC to match the cache
  // contract. timezone=UTC keeps datetimes unambiguous (default is exchange
  // local).
  async fetchHistoricalBars(input: FetchHistoricalBarsInput): Promise<Bar[]> {
    if (!Number.isInteger(input.limit) || input.limit <= 0) {
      throw new Error('limit must be a positive integer');
    }
    // prepost=true incluye pre/post market en US equities para 1min/5min
    // (plan Pro+). Necesario para que la cache de bootstrap cubra la sesión
    // pre y los indicadores se calculen sobre ese rango.
    const data = await this.client.request('time_series', {
      symbol: input.symbol,
      interval: input.interval,
      outputsize: String(input.limit),
      timezone: 'UTC',
      prepost: 'true',
    });
    const values = data.values ?? [];
    if (values.length === 0) {
      throw new Error(`Twelve Data: empty time_series for ${input.symbol}`);
    }
    return values.map(toBar).reverse();
  }
}

function toBar(v: TwelveDataValue): Bar {
  return {
    timestamp: parseUtcDatetime(v.datetime),
    open: parseNumber(v['open']),
    high: parseNumber(v['high']),
    low: parseNumber(v['low']),
    close: parseNumber(v['close']),
    volume: parseNumber(v['volume']),
  };
}

// Twelve Data with timezone=UTC returns 'YYYY-MM-DD HH:MM:SS' (no offset).
// Treat as UTC explicitly so downstream comparisons are unambiguous.
function parseUtcDatetime(s: string): string {
  return new Date(`${s.replace(' ', 'T')}Z`).toISOString();
}

function parseNumber(value: string | undefined): number {
  if (value === undefined || value === '') return 0;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}
