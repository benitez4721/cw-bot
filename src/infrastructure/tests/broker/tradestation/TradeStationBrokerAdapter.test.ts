import { describe, expect, it, vi } from 'vitest';
import { TradeStationBrokerAdapter } from '../../../broker/tradestation/TradeStationBrokerAdapter.js';
import type { TradeStationClient } from '../../../broker/tradestation/TradeStationClient.js';

interface TsLegPayload {
  Symbol: string;
  Quantity: string;
  BuyOrSell: string;
  ExecutionPrice?: string;
}

interface TsOrderPayload {
  OrderID: string;
  Status?: string;
  OrderType?: string;
  FilledPrice?: string;
  LimitPrice?: string;
  StopPrice?: string;
  AdvancedOptions?: string;
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

  it('retorna rejected con error de leg-detection si TS no devuelve los exits', async () => {
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

  it('deriva entry por exclusion cuando TS V3 404ea la entry en el GET por IDs', async () => {
    // Caso QCOM real: la entry (Limit @ cost) llena al instante y TS la marca
    // NotFound al consultarla por ID, pero los exits OSO/BRK quedan vivos.
    // El bracket sigue siendo valido: derivamos el entry orderId restandolo
    // del set del POST. Sin este fallback, el bracket queda rejected y nunca
    // se crea el TradeContext, dejando la posicion huerfana en TS.
    const { client } = fakeClient({
      place: {
        Orders: [
          { OrderID: '952057086' },
          { OrderID: '952057087' },
          { OrderID: '952057090' },
        ],
      },
      detail: {
        Orders: [
          {
            OrderID: '952057087',
            Status: 'DON',
            OrderType: 'Limit',
            LimitPrice: '208.44',
            Legs: [{ Symbol: 'QCOM', Quantity: '123', BuyOrSell: 'Sell' }],
          },
          {
            OrderID: '952057086',
            Status: 'OPN',
            OrderType: 'StopMarket',
            StopPrice: '201.33',
            Legs: [{ Symbol: 'QCOM', Quantity: '123', BuyOrSell: 'Sell' }],
          },
          // 952057090 (entry) viene como NotFound y no aparece aqui.
        ],
      },
    });

    const broker = new TradeStationBrokerAdapter({ client });
    const result = await broker.placeBracketOrder({
      symbol: 'QCOM',
      side: 'BUY',
      quantity: 123,
      entryLimitPrice: 203.36,
      stopOffset: 2.03,
      takeProfitOffset: 5.08,
    });

    expect(result.status).toBe('open');
    expect(result.entryOrderId).toBe('952057090');
    expect(result.stopOrderId).toBe('952057086');
    expect(result.takeProfitOrderId).toBe('952057087');
    expect(result.error).toBeUndefined();
  });
});

describe('TradeStationBrokerAdapter.getOrders', () => {
  function brokerWithOrders(
    orders: TsOrderPayload[],
  ): TradeStationBrokerAdapter {
    const client = {
      accountId: () => 'SIM12345',
      apiBase: () => 'https://sim.api.tradestation.com',
      request: vi.fn(async () => ({ Orders: orders })),
    } as unknown as TradeStationClient;
    return new TradeStationBrokerAdapter({ client });
  }

  it('mapea FilledPrice del root al filledPrice del Order', async () => {
    const broker = brokerWithOrders([
      {
        OrderID: '1',
        Status: 'FLL',
        OrderType: 'Limit',
        FilledPrice: '1.23',
        Legs: [{ Symbol: 'AAPL', Quantity: '100', BuyOrSell: 'Buy' }],
      },
    ]);

    const [order] = await broker.getOrders({});

    expect(order?.filledPrice).toBe(1.23);
  });

  it('cae a Legs[0].ExecutionPrice cuando FilledPrice es "0"', async () => {
    const broker = brokerWithOrders([
      {
        OrderID: '2',
        Status: 'FLL',
        OrderType: 'Limit',
        FilledPrice: '0',
        Legs: [
          {
            Symbol: 'AAPL',
            Quantity: '100',
            BuyOrSell: 'Buy',
            ExecutionPrice: '187.32',
          },
        ],
      },
    ]);

    const [order] = await broker.getOrders({});

    expect(order?.filledPrice).toBe(187.32);
  });

  it('deja filledPrice undefined cuando ni root ni leg tienen precio', async () => {
    const broker = brokerWithOrders([
      {
        OrderID: '3',
        Status: 'OPN',
        OrderType: 'Limit',
        Legs: [{ Symbol: 'AAPL', Quantity: '100', BuyOrSell: 'Buy' }],
      },
    ]);

    const [order] = await broker.getOrders({});

    expect(order?.filledPrice).toBeUndefined();
  });

  it('mapea AdvancedOptions al campo advancedOptions del Order', async () => {
    const broker = brokerWithOrders([
      {
        OrderID: '4',
        Status: 'OPN',
        OrderType: 'StopMarket',
        StopPrice: '1.56',
        AdvancedOptions: 'Trailing Stop',
        Legs: [{ Symbol: 'ORGN', Quantity: '2000', BuyOrSell: 'Sell' }],
      },
    ]);

    const [order] = await broker.getOrders({});

    expect(order?.advancedOptions).toBe('Trailing Stop');
  });

  it('advancedOptions queda undefined cuando TS no lo reporta', async () => {
    const broker = brokerWithOrders([
      {
        OrderID: '5',
        Status: 'ACK',
        OrderType: 'StopMarket',
        StopPrice: '1.50',
        Legs: [{ Symbol: 'AAPL', Quantity: '100', BuyOrSell: 'Sell' }],
      },
    ]);

    const [order] = await broker.getOrders({});

    expect(order?.advancedOptions).toBeUndefined();
  });
});

describe('TradeStationBrokerAdapter.placeTrailingBracketOrder', () => {
  interface CapturedRequest {
    method: string;
    path: string;
    body?: Record<string, unknown>;
  }

  function capturingClient(responses: {
    place: PlaceResponse;
    detail: DetailResponse;
  }): { client: TradeStationClient; calls: CapturedRequest[] } {
    const calls: CapturedRequest[] = [];
    const client = {
      accountId: () => 'SIM12345',
      apiBase: () => 'https://sim.api.tradestation.com',
      request: vi.fn(async (req: CapturedRequest) => {
        calls.push(req);
        if (req.method === 'POST') return responses.place;
        return responses.detail;
      }),
    } as unknown as TradeStationClient;
    return { client, calls };
  }

  it('arma BRK de un solo exit leg con AdvancedOptions.TrailingStop.Percent', async () => {
    const { client, calls } = capturingClient({
      place: {
        Orders: [{ OrderID: 'O-stop' }, { OrderID: 'O-entry' }],
      },
      detail: {
        Orders: [
          {
            OrderID: 'O-entry',
            Status: 'ACK',
            OrderType: 'Limit',
            LimitPrice: '1.70',
            Legs: [{ Symbol: 'ORGN', Quantity: '2000', BuyOrSell: 'BUY' }],
          },
          {
            OrderID: 'O-stop',
            Status: 'ACK',
            OrderType: 'StopMarket',
            StopPrice: '1.56',
            Legs: [{ Symbol: 'ORGN', Quantity: '2000', BuyOrSell: 'SELL' }],
          },
        ],
      },
    });

    const broker = new TradeStationBrokerAdapter({ client });
    const result = await broker.placeTrailingBracketOrder({
      symbol: 'ORGN',
      side: 'BUY',
      quantity: 2000,
      entryLimitPrice: 1.7,
      trailingStopPercent: 8,
    });

    expect(result.status).not.toBe('rejected');
    expect(result.entryOrderId).toBe('O-entry');
    expect(result.stopOrderId).toBe('O-stop');
    expect(result.takeProfitOrderId).toBeUndefined();

    const post = calls.find((c) => c.method === 'POST');
    const body = post?.body as {
      OSOs: Array<{ Type: string; Orders: Record<string, unknown>[] }>;
    };
    expect(body.OSOs).toHaveLength(1);
    expect(body.OSOs[0].Type).toBe('BRK');
    expect(body.OSOs[0].Orders).toHaveLength(1);
    const stopLeg = body.OSOs[0].Orders[0];
    expect(stopLeg.OrderType).toBe('StopMarket');
    expect(stopLeg.AdvancedOptions).toEqual({
      TrailingStop: { Percent: 8 },
    });
    expect(stopLeg.StopPrice).toBeUndefined();
  });

  it('identifica el stop trailing por OrderType (no por precio)', async () => {
    const { client } = capturingClient({
      place: {
        Orders: [{ OrderID: 'O-stop' }, { OrderID: 'O-entry' }],
      },
      detail: {
        Orders: [
          {
            OrderID: 'O-entry',
            Status: 'ACK',
            OrderType: 'Limit',
            LimitPrice: '1.70',
            Legs: [{ Symbol: 'ORGN', Quantity: '2000', BuyOrSell: 'BUY' }],
          },
          {
            OrderID: 'O-stop',
            Status: 'ACK',
            OrderType: 'StopMarket',
            // TS recalcula este precio dinámicamente; el matching no compara.
            StopPrice: '999.99',
            Legs: [{ Symbol: 'ORGN', Quantity: '2000', BuyOrSell: 'SELL' }],
          },
        ],
      },
    });

    const broker = new TradeStationBrokerAdapter({ client });
    const result = await broker.placeTrailingBracketOrder({
      symbol: 'ORGN',
      side: 'BUY',
      quantity: 2000,
      entryLimitPrice: 1.7,
      trailingStopPercent: 8,
    });

    expect(result.stopOrderId).toBe('O-stop');
    expect(result.status).not.toBe('rejected');
  });

  it('retorna rejected cuando el POST devuelve menos de 2 legs', async () => {
    const { client } = capturingClient({
      place: {
        Orders: [{ OrderID: 'O-only-one' }],
      },
      detail: { Orders: [] },
    });

    const broker = new TradeStationBrokerAdapter({ client });
    const result = await broker.placeTrailingBracketOrder({
      symbol: 'ORGN',
      side: 'BUY',
      quantity: 2000,
      entryLimitPrice: 1.7,
      trailingStopPercent: 8,
    });

    expect(result.status).toBe('rejected');
    expect(result.takeProfitOrderId).toBeUndefined();
  });
});
