import type {
  PositionStreamHandler,
  StreamConnectionHandler,
} from './BrokerStreamTypes.js';

// Realtime position events (cambios de qty, avg price, P&L). Long-lived
// connection; el adapter maneja la reconexión internamente. Una posición con
// quantity === 0 indica cierre — el manager la elimina del snapshot.
export interface PositionStreamPort {
  connect(): Promise<void>;
  disconnect(): void;
  onPosition(handler: PositionStreamHandler): void;
  onConnectionChange(handler: StreamConnectionHandler): void;
}
