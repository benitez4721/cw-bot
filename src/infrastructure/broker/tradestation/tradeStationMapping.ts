import type {
  OrderSide,
  OrderStatus,
  OrderType,
} from '../../../domain/broker/BrokerTypes.js';

export function parseNumber(value: string | number | undefined | null): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

export function mapStatus(code: string | undefined): OrderStatus {
  switch (code) {
    case 'ACK':
    case 'PND':
    case 'DON':
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

export function mapOrderType(value: string | undefined): OrderType {
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

export function mapSide(value: string | undefined): OrderSide {
  return value === 'Sell' || value === 'SELL' ? 'SELL' : 'BUY';
}
