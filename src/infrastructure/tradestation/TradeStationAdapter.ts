import type { BrokerPort, GetQuoteInput } from '../../domain/broker/BrokerPort.js';
import type {
  Balance,
  HistoricalOrder,
  Order,
  OrderResult,
  OrderSide,
  OrderStatus,
  OrderType,
  PlaceOrderInput,
  Position,
  Quote,
} from '../../domain/broker/BrokerTypes.js';

interface TradeStationConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accountId: string;
  simBaseUrl: string;
  liveBaseUrl: string;
  signinUrl: string;
}

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

interface TsBalance {
  AccountID: string;
  CashBalance?: string;
  BuyingPower?: string;
  Equity?: string;
  MarketValue?: string;
  TodaysProfitLoss?: string;
}

interface TsPosition {
  AccountID: string;
  Symbol: string;
  Quantity: string;
  AveragePrice: string;
  MarketValue?: string;
  UnrealizedProfitLoss?: string;
}

interface TsOrderLeg {
  Symbol?: string;
  Quantity?: string;
  ExecQuantity?: string;
  BuyOrSell?: string;
  ExecutionPrice?: string;
}

interface TsOrder {
  OrderID: string;
  Symbol?: string;
  Status: string;
  StatusDescription?: string;
  OrderType?: string;
  Quantity?: string;
  FilledQuantity?: string;
  LimitPrice?: string;
  StopPrice?: string;
  OpenedDateTime?: string;
  ClosedDateTime?: string;
  Legs?: TsOrderLeg[];
}

interface TsQuote {
  Symbol?: string;
  Last?: string;
  Bid?: string;
  Ask?: string;
  TradeTime?: string;
  Error?: string;
  Message?: string;
}

interface TsQuoteResponse {
  Quotes?: TsQuote[];
  Errors?: Array<{ Symbol?: string; Error?: string; Message?: string }>;
}

interface TsPlaceOrderResponse {
  Orders?: Array<{
    OrderID?: string;
    Message?: string;
    Error?: string;
    Status?: string;
  }>;
  Errors?: Array<{ AccountID?: string; Error?: string; Message?: string }>;
}

const TOKEN_REFRESH_MARGIN_MS = 60 * 1000;

export class TradeStationAdapter implements BrokerPort {
  private readonly config: TradeStationConfig;
  private tokenCache: TokenCache | null = null;
  private refreshPromise: Promise<string> | null = null;

  constructor(config: TradeStationConfig) {
    this.config = config;
  }

  async placeOrder(input: PlaceOrderInput): Promise<OrderResult> {
    const payload: Record<string, unknown> = {
      AccountID: this.config.accountId,
      Symbol: input.symbol,
      Quantity: String(input.quantity),
      OrderType: input.type,
      TradeAction: input.side,
      TimeInForce: { Duration: '1' },
      Route: 'Intelligent',
    };

    if (input.type === 'Limit' || input.type === 'StopLimit') {
      const adjusted = Math.round(input.limitPrice! * 0.999 * 100) / 100;
      payload.LimitPrice = String(adjusted);
    }
    if (input.type === 'StopMarket' || input.type === 'StopLimit') {
      payload.StopPrice = String(input.stopPrice);
    }

    const response = await this.request<TsPlaceOrderResponse>({
      method: 'POST',
      path: '/v3/orderexecution/orders',
      body: payload,
    });

    const first = response.Orders?.[0];
    if (!first || first.Error === 'FAILED') {
      return {
        orderId: first?.OrderID ?? '',
        status: 'rejected',
        message: first?.Message,
        error: first?.Error ?? response.Errors?.[0]?.Error ?? 'Unknown error',
      };
    }

    return {
      orderId: first.OrderID ?? '',
      status: mapStatus(first.Status),
      message: first.Message,
    };
  }

  async cancelOrder({ orderId }: { orderId: string }): Promise<OrderResult> {
    const response = await this.request<TsPlaceOrderResponse>({
      method: 'DELETE',
      path: `/v3/orderexecution/orders/${encodeURIComponent(orderId)}`,
    });

    const first = response.Orders?.[0];
    if (!first || first.Error === 'FAILED') {
      return {
        orderId,
        status: 'rejected',
        message: first?.Message,
        error: first?.Error ?? response.Errors?.[0]?.Error ?? 'Unknown error',
      };
    }

    return {
      orderId: first.OrderID ?? orderId,
      status: 'cancelled',
      message: first.Message,
    };
  }

  async replaceOrder({
    orderId,
    order,
  }: {
    orderId: string;
    order: PlaceOrderInput;
  }): Promise<OrderResult> {
    const payload: Record<string, unknown> = {
      Quantity: String(order.quantity),
      OrderType: order.type,
    };
    if (order.limitPrice !== undefined) payload.LimitPrice = String(order.limitPrice);
    if (order.stopPrice !== undefined) payload.StopPrice = String(order.stopPrice);

    const response = await this.request<TsPlaceOrderResponse>({
      method: 'PUT',
      path: `/v3/orderexecution/orders/${encodeURIComponent(orderId)}`,
      body: payload,
    });

    const first = response.Orders?.[0];
    if (!first || first.Error === 'FAILED') {
      return {
        orderId,
        status: 'rejected',
        message: first?.Message,
        error: first?.Error ?? response.Errors?.[0]?.Error ?? 'Unknown error',
      };
    }

    return {
      orderId: first.OrderID ?? orderId,
      status: mapStatus(first.Status),
      message: first.Message,
    };
  }

  async getBalances(): Promise<Balance> {
    const account = encodeURIComponent(this.config.accountId);
    const response = await this.request<{ Balances?: TsBalance[] }>({
      method: 'GET',
      path: `/v3/brokerage/accounts/${account}/balances`,
    });

    const b = response.Balances?.[0];
    return {
      cashBalance: parseNumber(b?.CashBalance),
      buyingPower: parseNumber(b?.BuyingPower),
      equity: parseNumber(b?.Equity),
      marketValue: parseNumber(b?.MarketValue),
      todaysProfitLoss: parseNumber(b?.TodaysProfitLoss),
    };
  }

  async getPositions(): Promise<Position[]> {
    const account = encodeURIComponent(this.config.accountId);
    const response = await this.request<{ Positions?: TsPosition[] }>({
      method: 'GET',
      path: `/v3/brokerage/accounts/${account}/positions`,
    });

    return (response.Positions ?? []).map((p) => ({
      symbol: p.Symbol,
      quantity: parseNumber(p.Quantity),
      averagePrice: parseNumber(p.AveragePrice),
      marketValue: parseNumber(p.MarketValue),
      unrealizedPnL: parseNumber(p.UnrealizedProfitLoss),
    }));
  }

  async getOrders({ symbol }: { symbol?: string }): Promise<Order[]> {
    const account = encodeURIComponent(this.config.accountId);
    const path = symbol
      ? `/v3/brokerage/accounts/${account}/orders?Symbol=${encodeURIComponent(symbol)}`
      : `/v3/brokerage/accounts/${account}/orders`;

    const response = await this.request<{ Orders?: TsOrder[] }>({
      method: 'GET',
      path,
    });

    return (response.Orders ?? []).map(toOrder);
  }

  async getQuote({ symbol }: GetQuoteInput): Promise<Quote> {
    const response = await this.request<TsQuoteResponse>({
      method: 'GET',
      path: `/v3/marketdata/quotes/${encodeURIComponent(symbol)}`,
    });

    const first = response.Quotes?.[0];
    if (!first || first.Error) {
      const reason =
        first?.Message ?? response.Errors?.[0]?.Message ?? first?.Error ?? 'unknown error';
      throw new Error(`[TradeStation] getQuote(${symbol}) failed: ${reason}`);
    }

    return {
      symbol: first.Symbol ?? symbol,
      last: parseNumber(first.Last),
      bid: first.Bid !== undefined ? parseNumber(first.Bid) : undefined,
      ask: first.Ask !== undefined ? parseNumber(first.Ask) : undefined,
      timestamp: first.TradeTime ?? new Date().toISOString(),
    };
  }

  async getHistoricalOrders({ since }: { since: string }): Promise<HistoricalOrder[]> {
    const account = encodeURIComponent(this.config.accountId);
    const response = await this.request<{ Orders?: TsOrder[] }>({
      method: 'GET',
      path: `/v3/brokerage/accounts/${account}/historicalorders?since=${encodeURIComponent(since)}`,
    });

    return (response.Orders ?? []).map((o) => {
      const base = toOrder(o);
      const firstLeg = o.Legs?.[0];
      return {
        ...base,
        filledAt: o.ClosedDateTime,
        filledPrice: firstLeg?.ExecutionPrice ? parseNumber(firstLeg.ExecutionPrice) : undefined,
      };
    });
  }

  private apiBase(): string {
    return this.config.accountId.startsWith('SIM') ? this.config.simBaseUrl : this.config.liveBaseUrl;
  }

  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.tokenCache && this.tokenCache.expiresAt - TOKEN_REFRESH_MARGIN_MS > now) {
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

  private async refreshSession(): Promise<string> {
    const tokenUrl = `${this.config.signinUrl}/oauth/token`;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      refresh_token: this.config.refreshToken,
    });

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`[TradeStation] refresh failed: HTTP ${res.status} ${text}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    if (!data.access_token) {
      throw new Error('[TradeStation] refresh response missing access_token');
    }

    this.tokenCache = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    console.log(`[TradeStation] Refreshed access token, expires in ${data.expires_in}s`);
    return this.tokenCache.accessToken;
  }

  private async request<T>({
    method,
    path,
    body,
  }: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    body?: unknown;
  }): Promise<T> {
    const token = await this.getAccessToken();
    const url = this.apiBase() + path;

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

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
      console.error(`[TradeStation] HTTP ${res.status} ${method} ${path}:`, text);
      throw new Error(`TradeStation API error: HTTP ${res.status}`);
    }

    return parsed as T;
  }
}

function parseNumber(value: string | number | undefined | null): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

function mapStatus(code: string | undefined): OrderStatus {
  switch (code) {
    case 'ACK':
    case 'PND':
      return 'pending';
    case 'OPN':
      return 'open';
    case 'FLL':
      return 'filled';
    case 'FPR':
      return 'partiallyFilled';
    case 'CAN':
    case 'OUT':
      return 'cancelled';
    case 'REJ':
    case 'BRO':
      return 'rejected';
    case 'EXP':
      return 'expired';
    default:
      return 'pending';
  }
}

function mapOrderType(value: string | undefined): OrderType {
  switch (value) {
    case 'Limit':
      return 'Limit';
    case 'StopMarket':
      return 'StopMarket';
    case 'StopLimit':
      return 'StopLimit';
    default:
      return 'Market';
  }
}

function mapSide(value: string | undefined): OrderSide {
  return value === 'Sell' || value === 'SELL' ? 'SELL' : 'BUY';
}

function toOrder(o: TsOrder): Order {
  const firstLeg = o.Legs?.[0];
  return {
    id: o.OrderID,
    symbol: o.Symbol ?? firstLeg?.Symbol ?? '',
    quantity: parseNumber(o.Quantity ?? firstLeg?.Quantity),
    side: mapSide(firstLeg?.BuyOrSell),
    type: mapOrderType(o.OrderType),
    status: mapStatus(o.Status),
    filledQuantity: o.FilledQuantity ? parseNumber(o.FilledQuantity) : undefined,
    limitPrice: o.LimitPrice ? parseNumber(o.LimitPrice) : undefined,
    stopPrice: o.StopPrice ? parseNumber(o.StopPrice) : undefined,
    createdAt: o.OpenedDateTime ?? '',
  };
}
