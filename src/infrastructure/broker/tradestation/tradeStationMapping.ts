import type {
  OrderSide,
  OrderStatus,
  OrderType,
} from '../../../domain/broker/BrokerTypes.js';
import { parseNumber } from '../../shared/parsing.js';

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

// TS reporta '0' como FilledPrice / ExecutionPrice cuando todavia no hubo
// ejecucion. No queremos propagar 0 como precio real. Estructural para que
// sirva tanto al REST (TsOrder) como al stream (TsStreamOrder).
interface FillPriceSource {
  FilledPrice?: string;
  Legs?: Array<{ ExecutionPrice?: string }>;
}

export function pickFilledPrice(o: FillPriceSource): number | undefined {
  const top = o.FilledPrice;
  if (top != null && top !== '' && top !== '0') {
    const n = parseNumber(top);
    if (n > 0) return n;
  }
  const legPrice = o.Legs?.[0]?.ExecutionPrice;
  if (legPrice != null && legPrice !== '' && legPrice !== '0') {
    const n = parseNumber(legPrice);
    if (n > 0) return n;
  }
  return undefined;
}
