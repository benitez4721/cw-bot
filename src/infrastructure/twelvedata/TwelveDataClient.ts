import { logger } from '../logging/logger.js';
import { sleep } from '../../shared/async.js';

const log = logger.child({ component: 'TwelveDataClient' });

export interface TwelveDataClientConfig {
  apiKey: string;
  baseUrl: string;
  minIntervalMs?: number;
}

export interface TwelveDataValue {
  datetime: string;
  [field: string]: string;
}

export interface TwelveDataResponse {
  status?: 'ok' | 'error';
  code?: number;
  message?: string;
  meta?: Record<string, unknown>;
  values?: TwelveDataValue[];
}

// Shared HTTP client and rate limiter for the Twelve Data API. The free tier
// caps at 8 req/min, so both adapters (indicators + historical bars) must
// share a single rate limiter to stay under the cap.
export class TwelveDataClient {
  private readonly minIntervalMs: number;
  private nextSlotAt = 0;

  constructor(private readonly config: TwelveDataClientConfig) {
    this.minIntervalMs = config.minIntervalMs ?? 7500;
  }

  async request(
    endpoint: string,
    params: Record<string, string>,
  ): Promise<TwelveDataResponse> {
    await this.waitForSlot();
    return this.doRequest(endpoint, params);
  }

  // Reserves the next time slot for this request and waits for it. Each call
  // claims a slot at least minIntervalMs after the previous one, so concurrent
  // callers get spaced out to stay under Twelve Data's free-tier cap (8 req/min).
  private async waitForSlot(): Promise<void> {
    const now = Date.now();
    const mySlot = Math.max(now, this.nextSlotAt);
    this.nextSlotAt = mySlot + this.minIntervalMs;
    const wait = mySlot - now;
    if (wait > 0) await sleep(wait);
  }

  private async doRequest(
    endpoint: string,
    params: Record<string, string>,
  ): Promise<TwelveDataResponse> {
    const url = new URL(`${this.config.baseUrl}/${endpoint}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('apikey', this.config.apiKey);
    url.searchParams.set('format', 'JSON');

    const res = await fetch(url);
    const text = await res.text();
    if (!res.ok) {
      log.error(
        {
          status: res.status,
          endpoint,
          symbol: params.symbol,
          body: text.slice(0, 200),
        },
        'http error',
      );
      throw new Error(`Twelve Data API error: HTTP ${res.status}`);
    }

    let parsed: TwelveDataResponse;
    try {
      parsed = JSON.parse(text) as TwelveDataResponse;
    } catch {
      throw new Error(
        `Twelve Data: invalid JSON response: ${text.slice(0, 200)}`,
      );
    }

    if (parsed.status === 'error') {
      throw new Error(
        `Twelve Data: ${parsed.message ?? 'unknown error'} (code ${parsed.code ?? '?'})`,
      );
    }
    return parsed;
  }
}
