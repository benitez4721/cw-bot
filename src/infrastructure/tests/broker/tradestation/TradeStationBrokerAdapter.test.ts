import { describe, expect, it, vi } from 'vitest';
import { TradeStationBrokerAdapter } from '../../../broker/tradestation/TradeStationBrokerAdapter.js';
import type { TradeStationClient } from '../../../broker/tradestation/TradeStationClient.js';

interface TsLegPayload {
  Symbol: string;
  Quantity: string;
  BuyOrSell: string;
}

interface TsOrderPayload {
  OrderID: string;
  Status?: string;
  OrderType?: string;
  LimitPrice?: string;
  StopPrice?: string;
  Legs?: TsLegPayload[];
}

interface PlaceResponse {
  Orders: Array<{ OrderID: string }>;
}

interface DetailResponse {
  Orders: TsOrderPayload[];
}

function fakeClient(responses: {
  place: PlaceResponse;
  detail: DetailResponse;
}): {
  client: TradeStationClient;
  paths: string[];
} {
  const paths: string[] = [];
  const client = {
    accountId: () => 'SIM12345',
    apiBase: () => 'https://sim.api.tradestation.com',
    request: vi.fn(async (req: { method: string; path: string }) => {
      paths.push(req.path);
      if (req.method === 'POST') return responses.place;
      return responses.detail;
    }),
  } as unknown as TradeStationClient;
  return { client, paths };
}

describe('TradeStationBrokerAdapter.placeBracketOrder', () => {
  it('identifica los 3 legs por (OrderType, precio) cuando BuyOrSell viene vacio', async () => {
    // Replica del caso DXF: entry filleo instantaneo y TS V3 devuelve
    // Legs[0].BuyOrSell vacio en el GET reconciliador. El detector basado en
    // BuyOrSell fallaba y dejaba el bracket 'rejected' con entryOrderId vacio.
    const { client } = fakeClient({
      place: {
        Orders: [
          { OrderID: '951874935' },
          { OrderID: '951874937' },
          { OrderID: '951874939' },
        ],
      },
      detail: {
        Orders: [
          {
            OrderID: '951874935',
            Status: 'ACK',
            OrderType: 'StopMarket',
            StopPrice: '1.43',
            Legs: [{ Symbol: 'DXF', Quantity: '2000', BuyOrSell: '' }],
          },
          {
            OrderID: '951874937',
            Status: 'ACK',
            OrderType: 'Limit',
            LimitPrice: '1.98',
            Legs: [{ Symbol: 'DXF', Quantity: '2000', BuyOrSell: '' }],
          },
          {
            OrderID: '951874939',
            Status: 'FLL',
            OrderType: 'Limit',
            LimitPrice: '1.63',
            Legs: [{ Symbol: 'DXF', Quantity: '2000', BuyOrSell: '' }],
          },
        ],
      },
    });

    const broker = new TradeStationBrokerAdapter({ client });
    const result = await broker.placeBracketOrder({
      symbol: 'DXF',
      side: 'BUY',
      quantity: 2000,
      entryLimitPrice: 1.63,
      stopOffset: 0.2,
      takeProfitOffset: 0.35,
    });

    expect(result.status).not.toBe('rejected');
    expect(result.entryOrderId).toBe('951874939');
    expect(result.stopOrderId).toBe('951874935');
    expect(result.takeProfitOrderId).toBe('951874937');
  });

  it('mantiene la deteccion correcta cuando TS V3 devuelve precios con decimales extra', async () => {
    const { client } = fakeClient({
      place: {
        Orders: [
          { OrderID: 'O-stop' },
          { OrderID: 'O-tp' },
          { OrderID: 'O-entry' },
        ],
      },
      detail: {
        Orders: [
          {
            OrderID: 'O-entry',
            Status: 'ACK',
            OrderType: 'Limit',
            LimitPrice: '5.7200',
            Legs: [{ Symbol: 'PAYS', Quantity: '2000', BuyOrSell: 'BUY' }],
          },
          {
            OrderID: 'O-stop',
            Status: 'ACK',
            OrderType: 'StopMarket',
            StopPrice: '5.5200',
            Legs: [{ Symbol: 'PAYS', Quantity: '2000', BuyOrSell: 'SELL' }],
          },
          {
            OrderID: 'O-tp',
            Status: 'ACK',
            OrderType: 'Limit',
            LimitPrice: '6.0700',
            Legs: [{ Symbol: 'PAYS', Quantity: '2000', BuyOrSell: 'SELL' }],
          },
        ],
      },
    });

    const broker = new TradeStationBrokerAdapter({ client });
    const result = await broker.placeBracketOrder({
      symbol: 'PAYS',
      side: 'BUY',
      quantity: 2000,
      entryLimitPrice: 5.72,
      stopOffset: 0.2,
      takeProfitOffset: 0.35,
    });

    expect(result.entryOrderId).toBe('O-entry');
    expect(result.stopOrderId).toBe('O-stop');
    expect(result.takeProfitOrderId).toBe('O-tp');
  });

  it('retorna rejected con error de leg-detection si TS no devuelve los 3 legs', async () => {
    const { client } = fakeClient({
      place: {
        Orders: [
          { OrderID: 'O-stop' },
          { OrderID: 'O-tp' },
          { OrderID: 'O-entry' },
        ],
      },
      detail: {
        Orders: [
          {
            OrderID: 'O-entry',
            Status: 'ACK',
            OrderType: 'Limit',
            LimitPrice: '5.72',
            Legs: [{ Symbol: 'PAYS', Quantity: '2000', BuyOrSell: 'BUY' }],
          },
          // Faltan stop y tp.
        ],
      },
    });

    const broker = new TradeStationBrokerAdapter({ client });
    const result = await broker.placeBracketOrder({
      symbol: 'PAYS',
      side: 'BUY',
      quantity: 2000,
      entryLimitPrice: 5.72,
      stopOffset: 0.2,
      takeProfitOffset: 0.35,
    });

    expect(result.status).toBe('rejected');
    expect(result.error).toBe('leg-detection-failed');
  });
});
