import type {
  BrokerPort,
  CancelOrderInput,
  GetOrdersInput,
  GetPositionsInput,
  GetQuoteInput,
  PlaceMarketOrderInput,
  ReplaceStopPriceInput,
} from '../../../domain/broker/BrokerPort.js';
import type {
  BracketOrderInput,
  BracketOrderResult,
  Order,
  OrderResult,
  OrderSide,
  PlaceLimitOrderInput,
  Position,
  Quote,
  TrailingBracketOrderInput,
} from '../../../domain/broker/BrokerTypes.js';
import type { OrderStatus } from '../../../domain/broker/BrokerTypes.js';
import type { TokenStatus } from './TradeStationClient.js';
import type { TradeStationClient } from './TradeStationClient.js';
import { logger } from '../../logging/logger.js';
import { round2 } from '../../../domain/shared/math.js';
import { parseNumber } from '../../shared/parsing.js';
import {
  mapOrderType,
  mapSide,
  mapStatus,
  pickFilledPrice,
} from './tradeStationMapping.js';

const log = logger.child({ component: 'TradeStationBrokerAdapter' });

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
  OpenOrClose?: string;
}

interface TsOrder {
  OrderID: string;
  Symbol?: string;
  Status: string;
  StatusDescription?: string;
  OrderType?: string;
  Quantity?: string;
  FilledQuantity?: string;
  FilledPrice?: string;
  LimitPrice?: string;
  StopPrice?: string;
  AdvancedOptions?: string;
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

interface TsCancelOrderResponse {
  OrderID?: string;
  Error?: string;
  Message?: string;
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

  async placeBracketOrder(
    input: BracketOrderInput,
  ): Promise<BracketOrderResult> {
    // Stop/TP precios calculados con entryLimitPrice como proxy del fill.
    // Si llena mejor, los offsets terminan asimétricos en cents — aceptado para v1.
    const cost = round2(input.entryLimitPrice);
    const exitSide: OrderSide = input.side === 'BUY' ? 'SELL' : 'BUY';
    const stopPrice =
      input.side === 'BUY'
        ? round2(cost - input.stopOffset)
        : round2(cost + input.stopOffset);
    const hasTakeProfit = input.takeProfitOffset !== undefined;
    const takeProfitPrice = hasTakeProfit
      ? input.side === 'BUY'
        ? round2(cost + input.takeProfitOffset!)
        : round2(cost - input.takeProfitOffset!)
      : undefined;

    const accountId = input.accountId;
    const exitLeg = {
      AccountID: accountId,
      Symbol: input.symbol,
      Quantity: String(input.quantity),
      TradeAction: exitSide,
      TimeInForce: { Duration: 'GTC' },
      Route: 'Intelligent',
    };

    const exitOrders: Record<string, unknown>[] = [
      {
        ...exitLeg,
        OrderType: 'StopMarket',
        StopPrice: String(stopPrice),
      },
    ];
    if (hasTakeProfit) {
      exitOrders.push({
        ...exitLeg,
        OrderType: 'Limit',
        LimitPrice: String(takeProfitPrice),
      });
    }

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
          Orders: exitOrders,
        },
      ],
    };

    const response = await this.client.request<TsPlaceOrderResponse>({
      method: 'POST',
      path: '/v3/orderexecution/orders',
      body: payload,
      operation: 'placeBracket',
      accountId,
    });

    const orders = response.Orders ?? [];
    const failed = orders.find((o) => o.Error === 'FAILED');
    const orderIds = orders
      .map((o) => o.OrderID)
      .filter((id): id is string => !!id);

    const expectedLegs = hasTakeProfit ? 3 : 2;
    if (
      orders.length < expectedLegs ||
      failed ||
      orderIds.length < expectedLegs
    ) {
      return {
        status: 'rejected',
        entryOrderId: orders[0]?.OrderID ?? '',
        stopOrderId: orders[1]?.OrderID ?? '',
        takeProfitOrderId: hasTakeProfit
          ? (orders[2]?.OrderID ?? '')
          : undefined,
        message: failed?.Message ?? orders[0]?.Message,
        error:
          failed?.Error ??
          orders[0]?.Error ??
          response.Errors?.[0]?.Error ??
          'Unknown error',
      };
    }

    // El POST no devuelve OrderType y el orden no es fiable: TS V3 retorna las
    // child orders del OSO/BRK antes que la parent. Reconsultamos por CSV para
    // mapear cada OrderID a su rol real. Cada exit tiene una huella unica
    // (OrderType, precio) que enviamos nosotros en el POST:
    //   stop → StopMarket + StopPrice === stopPrice
    //   tp   → Limit      + LimitPrice === takeProfitPrice
    // La entry NO la detectamos por precio: cuando llena al instante, TS V3
    // la 404ea en el GET por IDs (sale del set de open orders) aunque los
    // exits OSO/BRK queden vivos referenciandola en AdvancedOptions=OSO=<id>.
    // La derivamos por exclusion sobre los OrderIDs que devolvio el POST.
    const account = encodeURIComponent(accountId);
    const detail = await this.client.request<{ Orders?: TsOrder[] }>({
      method: 'GET',
      path: `/v3/brokerage/accounts/${account}/orders/${orderIds.join(',')}`,
      operation: 'getOrdersByIds',
      accountId,
    });
    const detailOrders = detail.Orders ?? [];
    const stop = detailOrders.find(
      (o) =>
        o.OrderType === 'StopMarket' &&
        parseNumber(o.StopPrice ?? '') === stopPrice,
    );
    const takeProfit = hasTakeProfit
      ? detailOrders.find(
          (o) =>
            o.OrderType === 'Limit' &&
            parseNumber(o.LimitPrice ?? '') === takeProfitPrice,
        )
      : undefined;

    if (!stop || (hasTakeProfit && !takeProfit)) {
      log.warn(
        {
          orderIds,
          expected: { cost, stopPrice, takeProfitPrice },
          detail,
        },
        'bracket leg detection failed — missing stop or take-profit in GET',
      );
      return {
        status: 'rejected',
        entryOrderId: '',
        stopOrderId: stop?.OrderID ?? '',
        takeProfitOrderId: hasTakeProfit
          ? (takeProfit?.OrderID ?? '')
          : undefined,
        message:
          'failed to identify bracket exit legs from TradeStation response',
        error: 'leg-detection-failed',
      };
    }

    const entryOrderId = orderIds.find(
      (id) => id !== stop.OrderID && id !== takeProfit?.OrderID,
    );
    if (!entryOrderId) {
      log.warn(
        {
          orderIds,
          expected: { cost, stopPrice, takeProfitPrice },
          detail,
        },
        'bracket leg detection failed — could not derive entry orderId',
      );
      return {
        status: 'rejected',
        entryOrderId: '',
        stopOrderId: stop.OrderID,
        takeProfitOrderId: takeProfit?.OrderID,
        message: 'failed to derive entry orderId from POST response',
        error: 'leg-detection-failed',
      };
    }

    const entry = detailOrders.find((o) => o.OrderID === entryOrderId);
    const status: OrderStatus = entry ? mapStatus(entry.Status) : 'open';
    if (!entry) {
      log.info(
        {
          orderIds,
          entryOrderId,
          stopOrderId: stop.OrderID,
          takeProfitOrderId: takeProfit?.OrderID,
        },
        'bracket entry not present in GET response — defaulting status to open; order stream will reconcile',
      );
    }

    return {
      status,
      entryOrderId,
      stopOrderId: stop.OrderID,
      takeProfitOrderId: takeProfit?.OrderID,
    };
  }

  async placeTrailingBracketOrder(
    input: TrailingBracketOrderInput,
  ): Promise<BracketOrderResult> {
    const cost = round2(input.entryLimitPrice);
    const exitSide: OrderSide = input.side === 'BUY' ? 'SELL' : 'BUY';
    const accountId = input.accountId;

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
              AccountID: accountId,
              Symbol: input.symbol,
              Quantity: String(input.quantity),
              TradeAction: exitSide,
              TimeInForce: { Duration: 'GTC' },
              Route: 'Intelligent',
              OrderType: 'StopMarket',
              AdvancedOptions: {
                TrailingStop: { Percent: input.trailingStopPercent },
              },
            },
          ],
        },
      ],
    };

    const response = await this.client.request<TsPlaceOrderResponse>({
      method: 'POST',
      path: '/v3/orderexecution/orders',
      body: payload,
      operation: 'placeBracket',
      accountId,
    });

    const orders = response.Orders ?? [];
    const failed = orders.find((o) => o.Error === 'FAILED');
    const orderIds = orders
      .map((o) => o.OrderID)
      .filter((id): id is string => !!id);

    if (orders.length < 2 || failed || orderIds.length < 2) {
      return {
        status: 'rejected',
        entryOrderId: orders[0]?.OrderID ?? '',
        stopOrderId: orders[1]?.OrderID ?? '',
        message: failed?.Message ?? orders[0]?.Message,
        error:
          failed?.Error ??
          orders[0]?.Error ??
          response.Errors?.[0]?.Error ??
          'Unknown error',
      };
    }

    // Trailing: stop se identifica como el único StopMarket del bracket — TS
    // recalcula StopPrice dinámicamente, no podemos matchear por precio.
    // La entry se deriva por exclusión sobre los OrderIDs del POST (mismo
    // patrón que placeBracketOrder, ver comentario allí).
    const account = encodeURIComponent(accountId);
    const detail = await this.client.request<{ Orders?: TsOrder[] }>({
      method: 'GET',
      path: `/v3/brokerage/accounts/${account}/orders/${orderIds.join(',')}`,
      operation: 'getOrdersByIds',
      accountId,
    });
    const detailOrders = detail.Orders ?? [];
    const stop = detailOrders.find((o) => o.OrderType === 'StopMarket');

    if (!stop) {
      log.warn(
        {
          orderIds,
          expected: {
            cost,
            trailingStopPercent: input.trailingStopPercent,
          },
          detail,
        },
        'trailing bracket leg detection failed — missing StopMarket in GET',
      );
      return {
        status: 'rejected',
        entryOrderId: '',
        stopOrderId: '',
        message:
          'failed to identify trailing stop leg from TradeStation response',
        error: 'leg-detection-failed',
      };
    }

    const entryOrderId = orderIds.find((id) => id !== stop.OrderID);
    if (!entryOrderId) {
      log.warn(
        {
          orderIds,
          expected: {
            cost,
            trailingStopPercent: input.trailingStopPercent,
          },
          detail,
        },
        'trailing bracket leg detection failed — could not derive entry orderId',
      );
      return {
        status: 'rejected',
        entryOrderId: '',
        stopOrderId: stop.OrderID,
        message: 'failed to derive entry orderId from POST response',
        error: 'leg-detection-failed',
      };
    }

    const entry = detailOrders.find((o) => o.OrderID === entryOrderId);
    const status: OrderStatus = entry ? mapStatus(entry.Status) : 'open';
    if (!entry) {
      log.info(
        {
          orderIds,
          entryOrderId,
          stopOrderId: stop.OrderID,
        },
        'trailing bracket entry not present in GET response — defaulting status to open; order stream will reconcile',
      );
    }

    return {
      status,
      entryOrderId,
      stopOrderId: stop.OrderID,
    };
  }

  async getPositions(input: GetPositionsInput): Promise<Position[]> {
    const accountId = input.accountId;
    const account = encodeURIComponent(accountId);
    const response = await this.client.request<{ Positions?: TsPosition[] }>({
      method: 'GET',
      path: `/v3/brokerage/accounts/${account}/positions`,
      operation: 'getPositions',
      accountId,
    });

    return (response.Positions ?? []).map((p) => ({
      symbol: p.Symbol,
      accountId,
      quantity: parseNumber(p.Quantity),
      averagePrice: parseNumber(p.AveragePrice),
      marketValue: parseNumber(p.MarketValue),
      unrealizedPnL: parseNumber(p.UnrealizedProfitLoss),
    }));
  }

  async getOrders({ symbol, accountId }: GetOrdersInput): Promise<Order[]> {
    const account = encodeURIComponent(accountId);
    const path = symbol
      ? `/v3/brokerage/accounts/${account}/orders?Symbol=${encodeURIComponent(symbol)}`
      : `/v3/brokerage/accounts/${account}/orders`;

    const response = await this.client.request<{ Orders?: TsOrder[] }>({
      method: 'GET',
      path,
      operation: 'getOrders',
      accountId,
    });

    return (response.Orders ?? []).map(toOrder);
  }

  async replaceStopPrice({
    orderId,
    stopPrice,
    accountId,
  }: ReplaceStopPriceInput): Promise<void> {
    await this.client.request<unknown>({
      method: 'PUT',
      path: `/v3/orderexecution/orders/${encodeURIComponent(orderId)}`,
      body: { StopPrice: String(round2(stopPrice)) },
      operation: 'replaceStop',
      accountId,
    });
  }

  // Idempotent: TradeStation may signal a non-cancellable order either via a
  // 4xx (request() throws) or via 200 OK with `Error` populated in the body
  // (terminal-state path observed in V2 and consistent with placeBracketOrder
  // V3 behavior). Both paths are swallowed with a warn so callers can fan out
  // cancels without racing on each individual leg's state.
  async cancelOrder({ orderId, accountId }: CancelOrderInput): Promise<void> {
    try {
      const response = await this.client.request<TsCancelOrderResponse>({
        method: 'DELETE',
        path: `/v3/orderexecution/orders/${encodeURIComponent(orderId)}`,
        operation: 'cancelOrder',
        accountId,
      });
      if (response?.Error) {
        log.warn(
          { orderId, error: response.Error, message: response.Message },
          'cancelOrder rejected by broker — order likely in terminal state',
        );
      }
    } catch (err) {
      log.warn(
        { orderId, err: err instanceof Error ? err.message : String(err) },
        'cancelOrder failed — order may already be filled or cancelled',
      );
    }
  }

  async placeMarketOrder({
    symbol,
    quantity,
    side,
    accountId,
  }: PlaceMarketOrderInput): Promise<OrderResult> {
    const payload = {
      AccountID: accountId,
      Symbol: symbol,
      Quantity: String(quantity),
      OrderType: 'Market',
      TradeAction: side,
      TimeInForce: { Duration: 'DAY' },
      Route: 'Intelligent',
    };

    const response = await this.client.request<TsPlaceOrderResponse>({
      method: 'POST',
      path: '/v3/orderexecution/orders',
      body: payload,
      operation: 'placeMarket',
      accountId,
    });

    return this.mapSingleOrderResponse(response);
  }

  async placeLimitOrder({
    symbol,
    quantity,
    side,
    limitPrice,
    accountId,
    duration,
    route,
  }: PlaceLimitOrderInput): Promise<OrderResult> {
    const payload = {
      AccountID: accountId,
      Symbol: symbol,
      Quantity: String(quantity),
      OrderType: 'Limit',
      LimitPrice: String(round2(limitPrice)),
      TradeAction: side,
      TimeInForce: { Duration: duration },
      Route: route ?? 'Intelligent',
    };

    const response = await this.client.request<TsPlaceOrderResponse>({
      method: 'POST',
      path: '/v3/orderexecution/orders',
      body: payload,
      operation: 'placeLimit',
      accountId,
    });

    return this.mapSingleOrderResponse(response);
  }

  private mapSingleOrderResponse(response: TsPlaceOrderResponse): OrderResult {
    const orders = response.Orders ?? [];
    const first = orders[0];
    const failed = orders.find((o) => o.Error === 'FAILED');

    if (!first || failed || !first.OrderID) {
      return {
        orderId: first?.OrderID ?? '',
        status: 'rejected',
        message: failed?.Message ?? first?.Message,
        error:
          failed?.Error ??
          first?.Error ??
          response.Errors?.[0]?.Error ??
          'Unknown error',
      };
    }

    return {
      orderId: first.OrderID,
      status: first.Status ? mapStatus(first.Status) : 'open',
      message: first.Message,
    };
  }

  async getQuote({ symbol, accountId }: GetQuoteInput): Promise<Quote> {
    const response = await this.client.request<TsQuoteResponse>({
      method: 'GET',
      path: `/v3/marketdata/quotes/${encodeURIComponent(symbol)}`,
      operation: 'getQuote',
      accountId,
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
    filledPrice: pickFilledPrice(o),
    limitPrice: o.LimitPrice ? parseNumber(o.LimitPrice) : undefined,
    stopPrice: o.StopPrice ? parseNumber(o.StopPrice) : undefined,
    advancedOptions: o.AdvancedOptions,
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
