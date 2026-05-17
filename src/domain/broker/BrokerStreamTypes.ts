import type { OrderWithContext, Position } from './BrokerTypes.js';

// Distingue eventos que reflejan el estado al momento de conectar
// (priorState) de cambios en vivo posteriores (liveUpdate). El cliente lo usa
// para no notificar/reaccionar a cosas que ya conocía (p. ej. tras reconectar).
export type EventOrigin = 'priorState' | 'liveUpdate';

export interface OrderEvent {
  order: OrderWithContext;
  observedAt: string;
  origin: EventOrigin;
}

export interface PositionEvent {
  position: Position;
  observedAt: string;
  origin: EventOrigin;
}

export type OrderStreamHandler = (event: OrderEvent) => void;
export type PositionStreamHandler = (event: PositionEvent) => void;
export type StreamConnectionHandler = (connected: boolean) => void;
