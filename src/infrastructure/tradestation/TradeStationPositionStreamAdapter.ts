import type { Position } from '../../domain/broker/BrokerTypes.js';
import type {
  PositionEvent,
  PositionStreamHandler,
  StreamConnectionHandler,
} from '../../domain/broker/BrokerStreamTypes.js';
import type { PositionStreamPort } from '../../domain/broker/PositionStreamPort.js';
import { logger } from '../logging/logger.js';
import type { TradeStationClient } from './TradeStationClient.js';
import { TradeStationStreamConnection } from './TradeStationStreamConnection.js';
import { parseNumber } from './tradeStationMapping.js';

const log = logger.child({ component: 'TradeStationPositionStreamAdapter' });

interface TsStreamPosition {
  PositionID?: string;
  AccountID?: string;
  Symbol?: string;
  LongShort?: string;
  Quantity?: string;
  AveragePrice?: string;
  MarketValue?: string;
  UnrealizedProfitLoss?: string;
  Timestamp?: string;
}

export interface TradeStationPositionStreamAdapterOptions {
  client: TradeStationClient;
  // Inyectables para tests (forwardeados al TradeStationStreamConnection).
  fetchFn?: typeof fetch;
  schedule?: (cb: () => void, ms: number) => NodeJS.Timeout;
  cancel?: (handle: NodeJS.Timeout) => void;
}

export class TradeStationPositionStreamAdapter implements PositionStreamPort {
  private readonly conn: TradeStationStreamConnection;
  private readonly positionHandlers: PositionStreamHandler[] = [];
  private readonly connectionHandlers: StreamConnectionHandler[] = [];
  private replayingPriorState = true;

  constructor(options: TradeStationPositionStreamAdapterOptions) {
    this.conn = new TradeStationStreamConnection({
      client: options.client,
      pathBuilder: (acct) =>
        `/v3/brokerage/stream/accounts/${encodeURIComponent(acct)}/positions`,
      onFrame: (frame) => this.handleFrame(frame),
      onConnectionChange: (connected) => this.handleConnectionChange(connected),
      logName: 'TradeStationPositionStreamAdapter',
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

  onPosition(handler: PositionStreamHandler): void {
    this.positionHandlers.push(handler);
  }

  onConnectionChange(handler: StreamConnectionHandler): void {
    this.connectionHandlers.push(handler);
  }

  private handleConnectionChange(connected: boolean): void {
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
      log.warn({ frame: f }, 'position stream error frame');
      return;
    }
    if (typeof f.Symbol !== 'string') return;

    const tsPos = f as unknown as TsStreamPosition;
    const position = mapStreamPosition(tsPos);
    const event: PositionEvent = {
      position,
      observedAt: new Date().toISOString(),
      origin: this.replayingPriorState ? 'priorState' : 'liveUpdate',
    };
    for (const h of this.positionHandlers) {
      try {
        h(event);
      } catch (err) {
        log.warn({ err: errMsg(err) }, 'onPosition handler threw');
      }
    }
  }
}

function mapStreamPosition(p: TsStreamPosition): Position {
  // Por consistencia con el broker REST (getPositions), 'quantity' va sin signo.
  // El long/short del frame no se expone al dominio porque Position no lo
  // modela hoy; el lado se infiere del trade context si hace falta.
  return {
    symbol: p.Symbol ?? '',
    quantity: parseNumber(p.Quantity),
    averagePrice: parseNumber(p.AveragePrice),
    marketValue: parseNumber(p.MarketValue),
    unrealizedPnL: parseNumber(p.UnrealizedProfitLoss),
  };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
