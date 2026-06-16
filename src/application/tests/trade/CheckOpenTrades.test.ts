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

function makePosition(over: Partial<Position> = {}): Position {
  return {
    symbol: 'AAPL',
    accountId: 'SIM12345',
    quantity: 100,
    averagePrice: 100,
    marketValue: 10_000,
    unrealizedPnL: 0,
    ...over,
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

describe('CheckOpenTrades — sesion pre', () => {
  it('ctx pre con entry filled + position abierta: stillExposed=true (no cierra)', async () => {
    // El bot abrio una alert pre: entry Limit DYP, no hay StopMarket en
    // broker. La entry llena y desaparece de las "ordenes activas". Sin
    // fallback de positions, CheckOpenTrades cerraria el ctx aunque la
    // posicion siga abierta — habilitando duplicados al llegar otra alerta.
    const ctx = makeContext({
      session: 'pre',
      bracket: { entryOrderId: 'E1' },
    });
    const { broker, tradeRepo, closeTrade, getPositions } = buildDeps({
      contexts: [ctx],
      orders: [],
      positions: [makePosition({ quantity: 2000 })],
    });
    const useCase = new CheckOpenTrades({ broker, tradeRepo, closeTrade });

    const result = await useCase.execute({ model: 'm', symbol: 'AAPL' });

    expect(getPositions).toHaveBeenCalledWith({ accountId: 'SIM12345' });
    expect(result.stillExposed).toBe(true);
    expect(closeTrade.execute).not.toHaveBeenCalled();
  });

  it('ctx pre sin orden activa ni position: cierra el ctx', async () => {
    // Caso esperado tras un exit que llego y dejo flat la posicion fuera del
    // tracking sintetico (ej. cierre manual desde otro lado).
    const ctx = makeContext({
      session: 'pre',
      bracket: { entryOrderId: 'E1' },
    });
    const { broker, tradeRepo, closeTrade } = buildDeps({
      contexts: [ctx],
      orders: [],
      positions: [],
    });
    const useCase = new CheckOpenTrades({ broker, tradeRepo, closeTrade });

    const result = await useCase.execute({ model: 'm', symbol: 'AAPL' });

    expect(result.stillExposed).toBe(false);
    expect(closeTrade.execute).toHaveBeenCalledWith('E1');
  });

  it('ctx pre con exit ya disparado (forcedExitOrderId) pero posicion abierta: stillExposed=true (no cierra)', async () => {
    // Regresion del bug de duplicados: el exit sintetico es un Limit que pudo
    // NO llenar (mercado fino). exit ya disparado + forced ya inactivo
    // NO implica cierre: si el broker reporta posicion abierta, el trade sigue
    // vivo y no debe tacharse — cerrarlo dejaria una posicion huerfana que
    // habilita un duplicado en la proxima alerta.
    const ctx = makeContext({
      session: 'pre',
      bracket: { entryOrderId: 'E1', forcedExitOrderId: 'X1' },
    });
    const { broker, tradeRepo, closeTrade, getPositions } = buildDeps({
      contexts: [ctx],
      orders: [], // el Limit de exit X1 expiro sin llenar; ya no esta activo
      positions: [makePosition({ quantity: 170 })],
    });
    const useCase = new CheckOpenTrades({ broker, tradeRepo, closeTrade });

    const result = await useCase.execute({ model: 'm', symbol: 'AAPL' });

    expect(getPositions).toHaveBeenCalledWith({ accountId: 'SIM12345' });
    expect(result.stillExposed).toBe(true);
    expect(closeTrade.execute).not.toHaveBeenCalled();
  });

  it('ctx pre con exit ya disparado (forcedExitOrderId) y sin posicion: cierra el ctx', async () => {
    // El exit sintetico llego y dejo flat la posicion: ni orden activa ni
    // posicion en el broker → el trade realmente cerro y se tacha.
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

    expect(getPositions).toHaveBeenCalledWith({ accountId: 'SIM12345' });
    expect(result.stillExposed).toBe(false);
    expect(closeTrade.execute).toHaveBeenCalledWith('E1');
  });

  it('ctx pre con forcedExit todavia open: stillExposed=true por la orden activa', async () => {
    // Con el forced Limit aun open, hasActive corta antes del fallback de
    // positions: el trade sigue expuesto por la orden viva, sin importar lo
    // que reporte getPositions.
    const ctx = makeContext({
      session: 'pre',
      bracket: { entryOrderId: 'E1', forcedExitOrderId: 'X1' },
    });
    const { broker, tradeRepo, closeTrade } = buildDeps({
      contexts: [ctx],
      orders: [makeOrder('X1', 'open')],
      positions: [],
    });
    const useCase = new CheckOpenTrades({ broker, tradeRepo, closeTrade });

    const result = await useCase.execute({ model: 'm', symbol: 'AAPL' });

    expect(result.stillExposed).toBe(true);
    expect(closeTrade.execute).not.toHaveBeenCalled();
  });

  it('ctx pre sin position pero en otra account: no marca stillExposed', async () => {
    // Defensa contra positions cross-account: aunque haya una position en
    // AAPL, si pertenece a otra cuenta, no es del ctx — no debe contar.
    const ctx = makeContext({
      accountId: 'SIM-A',
      session: 'pre',
      bracket: { entryOrderId: 'E1' },
    });
    const { broker, tradeRepo, closeTrade } = buildDeps({
      contexts: [ctx],
      orders: [],
      positions: [makePosition({ accountId: 'SIM-B', quantity: 100 })],
    });
    const useCase = new CheckOpenTrades({ broker, tradeRepo, closeTrade });

    const result = await useCase.execute({ model: 'm', symbol: 'AAPL' });

    expect(result.stillExposed).toBe(false);
    expect(closeTrade.execute).toHaveBeenCalledWith('E1');
  });
});
