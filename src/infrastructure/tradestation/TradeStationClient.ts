import type {
  MetricsPort,
  TsErrorType,
} from '../../domain/metrics/MetricsPort.js';
import { logger } from '../logging/logger.js';

const log = logger.child({ component: 'TradeStationClient' });

const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;
const USER_AGENT = 'cw-bot/1.0 (+https://github.com/flex/cw-bot)';

export interface TokenStatus {
  cached: boolean;
  expiresInMs: number;
}

export interface TradeStationClientConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accountId: string;
  simBaseUrl: string;
  liveBaseUrl: string;
  signinUrl: string;
  metrics?: MetricsPort;
}

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

// Shared OAuth + HTTP client for all TradeStation adapters (broker REST,
// order/position streams). Single in-flight refresh via refreshPromise so
// concurrent callers share one network round-trip.
export class TradeStationClient {
  private readonly config: TradeStationClientConfig;
  private readonly metrics?: MetricsPort;
  private tokenCache: TokenCache | null = null;
  private refreshPromise: Promise<string> | null = null;

  constructor(config: TradeStationClientConfig) {
    this.config = config;
    this.metrics = config.metrics;
  }

  accountId(): string {
    return this.config.accountId;
  }

  apiBase(): string {
    return this.config.accountId.startsWith('SIM')
      ? this.config.simBaseUrl
      : this.config.liveBaseUrl;
  }

  tokenStatus(): TokenStatus {
    if (!this.tokenCache) return { cached: false, expiresInMs: 0 };
    return {
      cached: true,
      expiresInMs: Math.max(0, this.tokenCache.expiresAt - Date.now()),
    };
  }

  // Drops the cached token so the next getAccessToken() forces a refresh.
  // Used by stream connections to recover from 401 mid-stream.
  invalidateToken(): void {
    this.tokenCache = null;
  }

  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (
      this.tokenCache &&
      this.tokenCache.expiresAt - TOKEN_REFRESH_MARGIN_MS > now
    ) {
      return this.tokenCache.accessToken;
    }
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = this.refreshSession().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  async request<T>({
    method,
    path,
    body,
  }: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    body?: unknown;
  }): Promise<T> {
    let token: string;
    try {
      token = await this.getAccessToken();
    } catch (err) {
      this.metrics?.recordTsRequest(0, 'auth');
      throw err;
    }
    const url = this.apiBase() + path;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'user-agent': USER_AGENT,
      accept: 'application/json',
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    const startedAt = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      this.metrics?.recordTsRequest(Date.now() - startedAt, 'network');
      throw err;
    }

    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      const errorType: TsErrorType =
        res.status >= 500 ? 'http_5xx' : 'http_4xx';
      this.metrics?.recordTsRequest(Date.now() - startedAt, errorType);
      log.error({ status: res.status, method, path, body: text }, 'http error');
      throw new Error(`TradeStation API error: HTTP ${res.status}`);
    }

    this.metrics?.recordTsRequest(Date.now() - startedAt);
    return parsed as T;
  }

  private async refreshSession(): Promise<string> {
    const tokenUrl = `${this.config.signinUrl}/oauth/token`;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.config.refreshToken,
    });

    try {
      const res = await fetch(tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
          'user-agent': USER_AGENT,
        },
        body: body.toString(),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.metrics?.recordOauthRefresh('failure');
        throw new Error(
          `[TradeStation] refresh failed: HTTP ${res.status} ${text}`,
        );
      }

      const data = (await res.json()) as {
        access_token: string;
        expires_in: number;
      };
      if (!data.access_token) {
        this.metrics?.recordOauthRefresh('failure');
        throw new Error('[TradeStation] refresh response missing access_token');
      }

      this.tokenCache = {
        accessToken: data.access_token,
        expiresAt: Date.now() + data.expires_in * 1000,
      };
      this.metrics?.recordOauthRefresh('success');
      log.info({ expiresInSec: data.expires_in }, 'refreshed access token');
      return this.tokenCache.accessToken;
    } catch (err) {
      if (
        err instanceof Error &&
        !err.message.startsWith('[TradeStation] refresh')
      ) {
        this.metrics?.recordOauthRefresh('failure');
      }
      throw err;
    }
  }
}
