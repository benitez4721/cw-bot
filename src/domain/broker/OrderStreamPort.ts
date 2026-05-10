import type {
  OrderStreamHandler,
  StreamConnectionHandler,
} from './BrokerStreamTypes.js';

// Realtime order events (entry/stop/TP fills, status transitions). Long-lived
// connection; el adapter maneja la reconexión internamente. El stream es por
// cuenta, no por símbolo — todas las orders de la cuenta llegan automáticamente.
export interface OrderStreamPort {
  connect(): Promise<void>;
  disconnect(): void;
  onOrder(handler: OrderStreamHandler): void;
  onConnectionChange(handler: StreamConnectionHandler): void;
}
