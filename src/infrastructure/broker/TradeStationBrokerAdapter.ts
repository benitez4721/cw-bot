import type {
  BrokerPort,
  GetQuoteInput,
  ReplaceStopPriceInput,
} from '../../domain/broker/BrokerPort.js';
import type {
  BracketOrderInput,
  BracketOrderResult,
  Order,
  OrderSide,
  Position,
  Quote,
} from '../../domain/broker/BrokerTypes.js';
import type { TokenStatus } from '../tradestation/TradeStationClient.js';
import type { TradeStationClient } from '../tradestation/TradeStationClient.js';
import {
  mapOrderType,
  mapSide,
  mapStatus,
  parseNumber,
} from '../tradestation/tradeStationMapping.js';

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

export interface TradeStationBrokerAdapterOptions {
  client: TradeStationClient;
}

export class TradeStationBrokerAdapter implements BrokerPort {
  private readonly client: TradeStationClient;

  constructor(options: TradeStationBrokerAdapterOptions) {
    this.client = options.client;
  }

  tokenStatus(): TokenStatus {
    return this.client.tokenStatus();
  }

  async placeBracketOrder(input: BracketOrderInput): Promise<BracketOrderResult> {
    // Stop/TP precios calculados con entryLimitPrice como proxy del fill.
    // Si llena mejor, los offsets terminan asimétricos en cents — aceptado para v1.
    const cost = round2(input.entryLimitPrice);
    const exitSide: OrderSide = input.side === 'BUY' ? 'SELL' : 'BUY';
    const stopPrice =
      input.side === 'BUY'
        ? round2(cost - input.stopOffset)
        : round2(cost + input.stopOffset);
    const takeProfitPrice =
      input.side === 'BUY'
        ? round2(cost + input.takeProfitOffset)
        : round2(cost - input.takeProfitOffset);

    const accountId = this.client.accountId();
    const exitLeg = {
      AccountID: accountId,
      Symbol: input.symbol,
      Quantity: String(input.quantity),
      TradeAction: exitSide,
      TimeInForce: { Duration: 'GTC' },
      Route: 'Intelligent',
    };

    const payload: Record<string, unknown> = {
      AccountID: accountId,
      Symbol: input.symbol,
      Quantity: String(input.quantity),
      OrderType: 'Limit',
      LimitPrice: String(cost),
      TradeAction: input.side,
      TimeInForce: { Duration: 'DAY' },
      Route: 'Intelligent',
      OSOs: [
        {
          Type: 'BRK',
          Orders: [
            {
              ...exitLeg,
              OrderType: 'StopMarket',
              StopPrice: String(stopPrice),
            },
            {
              ...exitLeg,
              OrderType: 'Limit',
              LimitPrice: String(takeProfitPrice),
            },
          ],
        },
      ],
    };

    const response = await this.client.request<TsPlaceOrderResponse>({
      method: 'POST',
      path: '/v3/orderexecution/orders',
      body: payload,
    });

    const orders = response.Orders ?? [];
    const entry = orders[0];
    const stop = orders[1];
    const takeProfit = orders[2];
    const failed = orders.find((o) => o.Error === 'FAILED');

    if (!entry || !stop || !takeProfit || failed) {
      return {
        status: 'rejected',
        entryOrderId: entry?.OrderID ?? '',
        stopOrderId: stop?.OrderID ?? '',
        takeProfitOrderId: takeProfit?.OrderID ?? '',
        message: failed?.Message ?? entry?.Message,
        error:
          failed?.Error ??
          entry?.Error ??
          response.Errors?.[0]?.Error ??
          'Unknown error',
      };
    }

    return {
      status: mapStatus(entry.Status),
      entryOrderId: entry.OrderID ?? '',
      stopOrderId: stop.OrderID ?? '',
      takeProfitOrderId: takeProfit.OrderID ?? '',
      message: entry.Message,
    };
  }

  async getPositions(): Promise<Position[]> {
    const account = encodeURIComponent(this.client.accountId());
    const response = await this.client.request<{ Positions?: TsPosition[] }>({
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
    const account = encodeURIComponent(this.client.accountId());
    const path = symbol
      ? `/v3/brokerage/accounts/${account}/orders?Symbol=${encodeURIComponent(symbol)}`
      : `/v3/brokerage/accounts/${account}/orders`;

    const response = await this.client.request<{ Orders?: TsOrder[] }>({
      method: 'GET',
      path,
    });

    return (response.Orders ?? []).map(toOrder);
  }

  async replaceStopPrice({
    orderId,
    stopPrice,
  }: ReplaceStopPriceInput): Promise<void> {
    await this.client.request<unknown>({
      method: 'PUT',
      path: `/v3/orderexecution/orders/${encodeURIComponent(orderId)}`,
      body: { StopPrice: String(round2(stopPrice)) },
    });
  }

  async getQuote({ symbol }: GetQuoteInput): Promise<Quote> {
    const response = await this.client.request<TsQuoteResponse>({
      method: 'GET',
      path: `/v3/marketdata/quotes/${encodeURIComponent(symbol)}`,
    });

    const first = response.Quotes?.[0];
    if (!first || first.Error) {
      const reason =
        first?.Message ??
        response.Errors?.[0]?.Message ??
        first?.Error ??
        'unknown error';
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
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
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
    filledQuantity: pickFilledQuantity(o, firstLeg),
    limitPrice: o.LimitPrice ? parseNumber(o.LimitPrice) : undefined,
    stopPrice: o.StopPrice ? parseNumber(o.StopPrice) : undefined,
    createdAt: o.OpenedDateTime ?? '',
  };
}

function pickFilledQuantity(
  o: TsOrder,
  firstLeg: TsOrderLeg | undefined,
): number | undefined {
  if (o.FilledQuantity != null) return parseNumber(o.FilledQuantity);
  if (firstLeg?.ExecQuantity != null) return parseNumber(firstLeg.ExecQuantity);
  return undefined;
}
