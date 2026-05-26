// Sesion del mercado US para equities. El bot opera en 'pre' y 'rth';
// 'transition' es la franja idle 9:20-9:30 (manager conectado al feed pero
// sin abrir nuevas posiciones — recien terminamos de flatear las del pre);
// 'closed' incluye fin de semana, feriados y horario post-market.
export type Session = 'pre' | 'transition' | 'rth' | 'closed';

export interface MarketHours {
  session(at: Date): Session;
  // Equivalente a session(at) === 'rth'. Se mantiene para los gates que solo
  // se interesan por la sesion regular (Heartbeat).
  isOpen(at: Date): boolean;
  // Ventana en que el BarStreamManager mantiene el feed conectado:
  // pre || transition || rth. Incluye el gap 9:20-9:30 para no apagar y
  // prender el feed entre sesiones.
  isConnected(at: Date): boolean;
}
