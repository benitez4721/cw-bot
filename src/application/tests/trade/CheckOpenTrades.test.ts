import { describe, expect, it, vi } from 'vitest';
import { CheckOpenTrades } from '../../../application/trade/CheckOpenTrades.js';
import { CloseTrade } from '../../../application/trade/CloseTrade.js';
import type { BrokerPort } from '../../../domain/broker/BrokerPort.js';
import type { Order, Position } from '../../../domain/broker/BrokerTypes.js';
import type { TradeContextRepository } from '../../../domain/trade/TradeContextRepository.js';
import type { TradeContext } from '../../../domain/trade/TradeTypes.js';

function makeContext(over: Partial<TradeContext> = {}): TradeContext {
  return {
    model: 'm',
    accountId: 'SIM12345',
    symbol: 'AAPL',
    side: 'BUY',
    entryLimitPrice: 100,
    evalStart: 't0',
    evalEnd: 't1',
    bracket: {
      entryOrderId: 'E1',
      stopOrderId: 'S1',
      takeProfitOrderId: 'T1',
    },
    indicators: null,
    checks: [],
    status: 'active',
    ...over,
  };
}

function makeOrder(id: string, status: Order['status'] = 'open'): Order {
  return {
    id,
    symbol: 'AAPL',
    quantity: 100,
    side: 'BUY',
    type: 'Limit',
    status,
    createdAt: 't',
  };
}

interface Setup {
  contexts: TradeContext[];
  orders: Order[];
  positions?: Position[];
}

function buildDeps(s: Setup) {
  const getPositions = vi.fn(async () => s.positions ?? []);
  const broker = {
    getOrders: vi.fn(async () => s.orders),
    getPositions,
  } as unknown as BrokerPort;
  const tradeRepo = {
    listActiveByModel: vi.fn(async () => s.contexts),
    put: vi.fn(async () => undefined),
  } as unknown as TradeContextRepository;
  const closeTrade = new CloseTrade(tradeRepo);
  vi.spyOn(closeTrade, 'execute').mockResolvedValue(undefined);
  return { broker, tradeRepo, closeTrade, getPositions };
}

describe('CheckOpenTrades — forcedExitOrderId', () => {
  it('mantiene stillExposed cuando el Market opuesto sigue open', async () => {
    const base = makeContext();
    const ctx: TradeContext = {
      ...base,
      bracket: { ...base.bracket, forcedExitOrderId: 'M1' },
    };
    const { broker, tradeRepo, closeTrade } = buildDeps({
      contexts: [ctx],
      // Stop+TP cancelados (no aparecen) pero el Market M1 está open
      orders: [makeOrder('M1', 'open')],
    });
    const useCase = new CheckOpenTrades({
      broker,
      tradeRepo,
      closeTrade,
    });

    const result = await useCase.execute({ model: 'm', symbol: 'AAPL' });
    expect(result.stillExposed).toBe(true);
    expect(closeTrade.execute).not.toHaveBeenCalled();
  });

  it('cierra el context cuando el Market opuesto ya llenó (no aparece en getOrders)', async () => {
    const base = makeContext();
    const ctx: TradeContext = {
      ...base,
      bracket: { ...base.bracket, forcedExitOrderId: 'M1' },
    };
    const { broker, tradeRepo, closeTrade } = buildDeps({
      contexts: [ctx],
      orders: [], // ningún OrderID del bracket+market activo
    });
    const useCase = new CheckOpenTrades({
      broker,
      tradeRepo,
      closeTrade,
    });

    const result = await useCase.execute({ model: 'm', symbol: 'AAPL' });
    expect(result.stillExposed).toBe(false);
    expect(closeTrade.execute).toHaveBeenCalledWith('E1');
  });

  it('comportamiento legacy preservado: bracket activo sin forcedExit mantiene stillExposed', async () => {
    const ctx = makeContext();
    const { broker, tradeRepo, closeTrade } = buildDeps({
      contexts: [ctx],
      orders: [makeOrder('S1', 'open')],
    });
    const useCase = new CheckOpenTrades({
      broker,
      tradeRepo,
      closeTrade,
    });

    const result = await useCase.execute({ model: 'm', symbol: 'AAPL' });
    expect(result.stillExposed).toBe(true);
    expect(closeTrade.execute).not.toHaveBeenCalled();
  });
});

describe('CheckOpenTrades — sesion pre (gate puro sobre Redis)', () => {
  it('ctx pre activo: stillExposed=true sin consultar el broker ni cerrar', async () => {
    // Regresión del bug de duplicados (ICCM): el guard pre NO debe leer el
    // broker. Mientras exista un ctx pre activo en Redis, el símbolo está
    // expuesto — la posición del broker es neta-agregada y el exit sintético
    // se cancela/recoloca cada barra, así que el broker da falsos negativos
    // que abrían trades duplicados.
    const ctx = makeContext({
      session: 'pre',
      bracket: { entryOrderId: 'E1' },
    });
    const { broker, tradeRepo, closeTrade, getPositions } = buildDeps({
      contexts: [ctx],
      orders: [],
      positions: [],
    });
    const useCase = new CheckOpenTrades({ broker, tradeRepo, closeTrade });

    const result = await useCase.execute({ model: 'm', symbol: 'AAPL' });

    expect(result.stillExposed).toBe(true);
    expect(closeTrade.execute).not.toHaveBeenCalled();
    expect(getPositions).not.toHaveBeenCalled();
    expect(broker.getOrders).not.toHaveBeenCalled();
  });

  it('ctx pre con exit ya disparado (forcedExitOrderId): stillExposed=true sin tocar el broker', async () => {
    // Aunque el exit sintético ya se disparó, el cierre del ctx lo hacen
    // RecordOrderFill / el self-heal del repeg / el flatten — nunca este gate.
    // Hasta que eso ocurra, el ctx sigue activo y el símbolo expuesto.
    const ctx = makeContext({
      session: 'pre',
      bracket: { entryOrderId: 'E1', forcedExitOrderId: 'X1' },
    });
    const { broker, tradeRepo, closeTrade, getPositions } = buildDeps({
      contexts: [ctx],
      orders: [],
      positions: [],
    });
    const useCase = new CheckOpenTrades({ broker, tradeRepo, closeTrade });

    const result = await useCase.execute({ model: 'm', symbol: 'AAPL' });

    expect(result.stillExposed).toBe(true);
    expect(closeTrade.execute).not.toHaveBeenCalled();
    expect(getPositions).not.toHaveBeenCalled();
  });

  it('contexts mixtos pre+rth: el pre activo basta para stillExposed, no reconcilia rth esta vuelta', async () => {
    const pre = makeContext({
      session: 'pre',
      bracket: { entryOrderId: 'E1' },
    });
    const rth = makeContext({
      session: 'rth',
      bracket: { entryOrderId: 'E2', stopOrderId: 'S2' },
    });
    const { broker, tradeRepo, closeTrade } = buildDeps({
      contexts: [pre, rth],
      orders: [], // E2/S2 inactivos, pero no se cierra mientras haya pre activo
    });
    const useCase = new CheckOpenTrades({ broker, tradeRepo, closeTrade });

    const result = await useCase.execute({ model: 'm', symbol: 'AAPL' });

    expect(result.stillExposed).toBe(true);
    expect(closeTrade.execute).not.toHaveBeenCalled();
    expect(broker.getOrders).not.toHaveBeenCalled();
  });
});
