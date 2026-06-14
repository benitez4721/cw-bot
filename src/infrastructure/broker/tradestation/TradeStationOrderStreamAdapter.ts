import type { Order } from '../../../domain/broker/BrokerTypes.js';
import type {
  OrderEvent,
  OrderStreamHandler,
  StreamConnectionHandler,
} from '../../../domain/broker/BrokerStreamTypes.js';
import type { OrderStreamPort } from '../../../domain/broker/OrderStreamPort.js';
import { logger } from '../../logging/logger.js';
import { errMsg } from '../../../shared/errors.js';
import { parseNumber } from '../../shared/parsing.js';
import type { TradeStationClient } from './TradeStationClient.js';
import { TradeStationStreamConnection } from './TradeStationStreamConnection.js';
import {
  mapOrderType,
  mapSide,
  mapStatus,
  pickFilledPrice,
} from './tradeStationMapping.js';

const log = logger.child({ component: 'TradeStationOrderStreamAdapter' });

interface TsStreamOrderLeg {
  Symbol?: string;
  QuantityOrdered?: string;
  ExecQuantity?: string;
  BuyOrSell?: string;
  ExecutionPrice?: string;
}

interface TsStreamOrder {
  OrderID: string;
  Symbol?: string;
  Status?: string;
  StatusDescription?: string;
  OrderType?: string;
  FilledPrice?: string;
  LimitPrice?: string;
  StopPrice?: string;
  OpenedDateTime?: string;
  Legs?: TsStreamOrderLeg[];
}

export interface TradeStationOrderStreamAdapterOptions {
  client: TradeStationClient;
  // Account contra el que abrir el websocket. Una instancia del adapter
  // mantiene UN websocket; el composition root crea N instancias si hace
  // falta cubrir varios accounts.
  accountId: string;
  // Inyectables para tests (forwardeados al TradeStationStreamConnection).
  fetchFn?: typeof fetch;
  schedule?: (cb: () => void, ms: number) => NodeJS.Timeout;
  cancel?: (handle: NodeJS.Timeout) => void;
}

export class TradeStationOrderStreamAdapter implements OrderStreamPort {
  private readonly accountId: string;
  private readonly conn: TradeStationStreamConnection;
  private readonly orderHandlers: OrderStreamHandler[] = [];
  private readonly connectionHandlers: StreamConnectionHandler[] = [];
  // El flag arranca true en cada (re)conexión y pasa a false cuando llega el
  // {StreamStatus:'EndSnapshot'}. Determina el `origin` de cada OrderEvent.
  private replayingPriorState = true;

  constructor(options: TradeStationOrderStreamAdapterOptions) {
    this.accountId = options.accountId;
    this.conn = new TradeStationStreamConnection({
      client: options.client,
      accountId: options.accountId,
      pathBuilder: (acct) =>
        `/v3/brokerage/stream/accounts/${encodeURIComponent(acct)}/orders`,
      onFrame: (frame) => this.handleFrame(frame),
      onConnectionChange: (connected) => this.handleConnectionChange(connected),
      logName: 'TradeStationOrderStreamAdapter',
      fetchFn: options.fetchFn,
      schedule: options.schedule,
      cancel: options.cancel,
    });
  }

  async connect(): Promise<void> {
    this.conn.start();
  }

  disconnect(): void {
    this.conn.stop();
  }

  onOrder(handler: OrderStreamHandler): void {
    this.orderHandlers.push(handler);
  }

  onConnectionChange(handler: StreamConnectionHandler): void {
    this.connectionHandlers.push(handler);
  }

  private handleConnectionChange(connected: boolean): void {
    // Cada vez que se reabre la conexión, TS reenvía el snapshot; resetear
    // el flag para que los frames hasta el próximo EndSnapshot se marquen
    // como 'priorState'.
    if (connected) this.replayingPriorState = true;
    for (const h of this.connectionHandlers) {
      try {
        h(connected);
      } catch (err) {
        log.warn({ err: errMsg(err) }, 'onConnectionChange handler threw');
      }
    }
  }

  private handleFrame(frame: unknown): void {
    if (typeof frame !== 'object' || frame === null) return;
    const f = frame as Record<string, unknown>;
    if ('Heartbeat' in f) return;
    if ('StreamStatus' in f) {
      if (f.StreamStatus === 'EndSnapshot') this.replayingPriorState = false;
      return;
    }
    if ('Error' in f) {
      log.warn({ frame: f }, 'order stream error frame');
      return;
    }
    if (typeof f.OrderID !== 'string') return;

    const tsOrder = f as unknown as TsStreamOrder;
    const order = mapStreamOrder(tsOrder);
    const event: OrderEvent = {
      order,
      accountId: this.accountId,
      observedAt: new Date().toISOString(),
      origin: this.replayingPriorState ? 'priorState' : 'liveUpdate',
    };
    for (const h of this.orderHandlers) {
      try {
        h(event);
      } catch (err) {
        log.warn({ err: errMsg(err) }, 'onOrder handler threw');
      }
    }
  }
}

function mapStreamOrder(o: TsStreamOrder): Order {
  const firstLeg = o.Legs?.[0];
  return {
    id: o.OrderID,
    symbol: o.Symbol ?? firstLeg?.Symbol ?? '',
    quantity: parseNumber(firstLeg?.QuantityOrdered),
    side: mapSide(firstLeg?.BuyOrSell),
    type: mapOrderType(o.OrderType),
    status: mapStatus(o.Status),
    filledQuantity: pickFilledQuantity(firstLeg),
    filledPrice: pickFilledPrice(o),
    limitPrice: o.LimitPrice ? parseNumber(o.LimitPrice) : undefined,
    stopPrice: o.StopPrice ? parseNumber(o.StopPrice) : undefined,
    createdAt: o.OpenedDateTime ?? '',
  };
}

function pickFilledQuantity(
  leg: TsStreamOrderLeg | undefined,
): number | undefined {
  if (leg?.ExecQuantity == null) return undefined;
  return parseNumber(leg.ExecQuantity);
}
