# cw-bot

Bot de trading automatizado sobre TradeStation. Consume señales de scanner desde
ChartsWatcher, mantiene un stream realtime de barras 1‑min vía Polygon, evalúa
decision models hexagonales y coloca bracket orders (entry + stop + take‑profit)
en el broker. Stack: Fastify 5, TypeScript estricto (ESM, ES2022), Redis para
estado, Prometheus + Grafana Cloud para observabilidad.

> Esta es la documentación operativa del repo. Para detalles finos de
> convenciones de código y arquitectura ver [`CLAUDE.md`](./CLAUDE.md).

## Tabla de contenidos

- [¿Qué hace?](#qué-hace)
- [Stack](#stack)
- [Arquitectura](#arquitectura)
- [Setup local — paso a paso](#setup-local--paso-a-paso)
- [Variables de entorno](#variables-de-entorno)
- [Scripts](#scripts)
- [API HTTP](#api-http)
- [Observabilidad](#observabilidad)
- [Deploy](#deploy)
- [Convenciones de código](#convenciones-de-código)
- [Troubleshooting](#troubleshooting)
- [Referencias](#referencias)

## ¿Qué hace?

El bot opera como un pipeline event‑driven con cuatro etapas:

**1) Scanner → Watchlist.** ChartsWatcher empuja, por WebSocket, los símbolos
que matchean un scan configurado (uno por estrategia). `ScannerMonitor` los
persiste en Redis por estrategia, marcando los que dejan de matchear como
stale. Cada estrategia mantiene su propio keyspace de watchlist — son
independientes.

**2) Watchlist → Bar stream.** `BarStreamManager` sincroniza, cada
~10 segundos, la unión de todas las watchlists. Para cada símbolo nuevo hace
bootstrap de las últimas `BOOTSTRAP_BARS` barras 1‑min y 5‑min vía TwelveData
(REST), las guarda en Redis y se suscribe al canal `AM` (aggregate minute) de
Polygon. Cuando llega una nueva barra de 1‑min cierra el bucket de 5‑min por
agregación local — no se piden 5‑min al feed.

**3) Cierre de barra → Decision.** En cada cierre, por cada estrategia,
`processStrategy()` (a) reconcilia los trades abiertos contra el broker, (b) si
hay exposición activa y la estrategia define `trailToBreakEvenAtProfit`, mueve
el stop al entry cuando el profit no realizado supera el umbral (one‑shot,
idempotente), y (c) si no hay exposición, construye un snapshot de indicadores
(MACD 1‑min/5‑min, VWAP, quote) y evalúa el decision model.

**4) Signal `buy` → Bracket order.** Si el modelo emite `buy`, se envía a
TradeStation un único payload OSO: limit de entry + stop‑market + limit de
take‑profit (`BrokerPort.placeBracketOrder`). El `TradeContext` con los tres
order IDs, snapshot de indicadores y checks ejecutados se guarda en Redis
hasta que la bracket desaparece del broker (fill TP, fill stop, cancel o
expiry), momento en el que se marca como `closed`.

Observabilidad cross‑cutting: métricas Prometheus locales en `/metrics`, push
opcional a Grafana Cloud, heartbeat opcional a BetterStack (sólo durante
horario regular de mercado), y logs estructurados (`pino`) con Logtail
opcional.

## Stack

| Capa            | Tecnología                                |
| --------------- | ----------------------------------------- |
| Runtime         | Node 20 (alpine en prod) + `tsx` en dev   |
| Framework HTTP  | Fastify 5 (ESM)                           |
| Lenguaje        | TypeScript 5, `strict`, ES2022, ESNext    |
| Persistencia    | Redis 7 (`ioredis`)                       |
| WebSocket       | `ws` (Polygon, ChartsWatcher)             |
| Métricas        | `prom-client` + `prometheus-remote-write` |
| Logs            | `pino` + `@logtail/pino`                  |
| Tests           | Vitest                                    |
| Lint / Format   | ESLint + Prettier + Husky + lint‑staged   |
| Package manager | pnpm 10.31                                |

## Arquitectura

Layout hexagonal (ports & adapters):

```
src/
├── domain/           Tipos puros + interfaces de port. Sin I/O ni framework.
│   ├── broker/       BrokerPort, OrderStreamPort, PositionStreamPort
│   ├── decision/     DecisionModel + models/{MacdM1CrossOver,Super}
│   ├── indicators/   IndicatorPort (MACD, EMA, VWAP)
│   ├── market/       MarketHours (RTH + holidays)
│   ├── marketdata/   MarketFeedPort, HistoricalBarsPort, BarRepository
│   ├── metrics/      MetricsPort
│   ├── scanner/      ScannerFeedPort
│   ├── trade/        TradeContextRepository + TradeTypes
│   └── watchlist/    WatchlistRepository
│
├── application/      Use cases. Dependen sólo de domain ports.
│   ├── broker/       PlaceBracketOrder, GetOrders
│   ├── heartbeat/    Heartbeat
│   ├── marketdata/   BarStreamManager   ← loop principal
│   ├── orderstream/  OrderStreamManager
│   ├── positionstream/ PositionStreamManager
│   ├── trade/        CheckOpenTrades, MaybeMoveStopToBreakEven, RecordTradeContext, CloseTrade
│   └── watchlist/    ScannerMonitor, ListWatchlist
│
├── infrastructure/   Adapters concretos + Fastify + env + logging + metrics
│   ├── broker/tradestation/   Vendor folder (3 adapters + client + mapping)
│   ├── marketdata/            Polygon, TwelveData histórico, RedisBarRepository
│   ├── scanner/               ChartsWatcherScannerFeedAdapter
│   ├── indicators/            LocalIndicatorAdapter (calcs sobre BarRepository)
│   ├── twelvedata/            TwelveDataClient (rate limiter compartido)
│   ├── trade/                 RedisTradeContextRepository
│   ├── watchlist/             RedisWatchlistRepository
│   ├── metrics/               PrometheusMetricsAdapter, GrafanaCloudWriter
│   ├── market/                UsMarketHoursAdapter
│   ├── http/                  Routes, server, authMiddleware
│   ├── logging/               pino + Logtail
│   └── config/                env
│
├── adaptersSetup.ts  Composition: arma todos los adapters y la lista de
│                     ConfiguredStrategy (modelo + watchlist + cwConfigId).
└── main.ts           Entry point: setupAdapters() → use cases → managers →
                      auth → routes → server.listen() → shutdown hooks.
```

### Ports clave

| Port                     | Archivo                                       | Responsabilidad                                                        |
| ------------------------ | --------------------------------------------- | ---------------------------------------------------------------------- |
| `BrokerPort`             | `src/domain/broker/BrokerPort.ts`             | `placeBracketOrder`, `getOrders`, `getQuote`, `replaceStopPrice`, etc. |
| `OrderStreamPort`        | `src/domain/broker/OrderStreamPort.ts`        | Push de updates de órdenes en realtime                                 |
| `PositionStreamPort`     | `src/domain/broker/PositionStreamPort.ts`     | Push de cambios de posición en realtime                                |
| `MarketFeedPort`         | `src/domain/marketdata/MarketFeedPort.ts`     | Suscripción a barras 1‑min realtime                                    |
| `HistoricalBarsPort`     | `src/domain/marketdata/HistoricalBarsPort.ts` | REST backfill de barras históricas                                     |
| `BarRepository`          | `src/domain/marketdata/BarRepository.ts`      | Cache persistente de barras (1‑min, 5‑min)                             |
| `ScannerFeedPort`        | `src/domain/scanner/ScannerFeedPort.ts`       | Push de símbolos entrando/saliendo de un scanner                       |
| `IndicatorPort`          | `src/domain/indicators/IndicatorPort.ts`      | Cálculo de MACD, EMA, VWAP                                             |
| `WatchlistRepository`    | `src/domain/watchlist/WatchlistRepository.ts` | Set de símbolos activos por estrategia                                 |
| `TradeContextRepository` | `src/domain/trade/TradeContextRepository.ts`  | Persistencia por trade (decision snapshot, bracket IDs, ciclo de vida) |
| `MarketHours`            | `src/domain/market/MarketHours.ts`            | RTH + calendario de holidays US                                        |
| `MetricsPort`            | `src/domain/metrics/MetricsPort.ts`           | Counters / gauges / histograms                                         |

### Estrategias configuradas

Declaradas en [`src/adaptersSetup.ts`](./src/adaptersSetup.ts). Cada estrategia
empareja un modelo de decisión con su scanner CW y su watchlist (keyspace
Redis separado).

| Estrategia        | Modelo                         | Indicadores                        | Evaluación   | Sizing                        | Stop / TP     | Trail a BE | CW `config_id`             |
| ----------------- | ------------------------------ | ---------------------------------- | ------------ | ----------------------------- | ------------- | ---------- | -------------------------- |
| `MacdM1CrossOver` | `MacdM1CrossOverDecisionModel` | MACD 5m, MACD 1m (last 2), VWAP 1m | Cierre 1‑min | 2000 shares (fijo)            | −0.20 / +0.35 | —          | `69b85e8d373a8a104a52803b` |
| `Super`           | `SuperDecisionModel`           | MACD 5m (series), VWAP 5m, quote   | Cierre 5‑min | `floor($25 000 / last_price)` | −1% / +2.5%   | +0.5%      | `69f6bec1f52a7e93e345cd0c` |

Los `config_id` son punteros opacos a scanners ya creados en ChartsWatcher
(el filtro RVOL/criterios vive del lado de CW). Para apuntar a otros scanners,
editar la constante en `adaptersSetup.ts`.

### Bracket order shape

Una bracket order viaja como un único payload OSO a TradeStation: un limit
de entry + dos legs GTC (stop‑market y limit) que se activan cuando el entry
fillea. La forma del port (`BracketOrderInput`) es deliberadamente
bracket‑shaped — no existe un "place generic order" en `BrokerPort`. Detalle
en [`src/domain/broker/BrokerTypes.ts`](./src/domain/broker/BrokerTypes.ts) y
notas de implementación en [`CLAUDE.md`](./CLAUDE.md#tradestation-adapter--non-obvious-behaviors).

### Convención de adapters

Vendor‑folder cuando un proveedor implementa 2+ ports o trae estado
compartido (OAuth, rate limiter, mappers). Port‑folder cuando es un único
adapter sin estado vendor‑específico. Detalle exhaustivo en
[`CLAUDE.md`](./CLAUDE.md#adapter-naming-and-folder-convention).

## Setup local — paso a paso

### 1. Prerequisitos

- Node ≥ 20 (probado con 20 alpine en prod).
- pnpm ≥ 10.31 (`corepack enable` o `npm i -g pnpm`).
- Redis 7 local (Docker o nativo) **o** una connection string a Upstash /
  Redis administrado.
- Docker (opcional, para correr Redis o el bot containerizado).

### 2. Clonar e instalar

```bash
git clone <url>
cd cw-bot
pnpm install
```

El `prepare` script instala los hooks de Husky automáticamente.

### 3. Levantar Redis

Opción A — Docker local:

```bash
docker run -d --name cw-redis -p 6379:6379 redis:7-alpine
# REDIS_URL=redis://localhost:6379
```

Opción B — Upstash (free tier, 10k commands/día — alcanza para dev):
crear database → copiar la TLS connection string al `.env` como `REDIS_URL`.

### 4. Conseguir credenciales

| Vendor            | Para qué                          | Cómo obtener                                                                                                                                                                                                                                      |
| ----------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **TradeStation**  | Broker (orders, quotes, streams)  | Crear app en `developer.tradestation.com` → guardar `Client ID` y `Client Secret`. El `refresh_token` se mintea localmente con `pnpm oauth:refresh-token` (ver más abajo). `Account ID` con prefijo `SIM…` enrutará al simulador automáticamente. |
| **Polygon.io**    | Feed realtime 1‑min (WS canal AM) | Signup en `polygon.io` → API Keys. **Requiere plan Stocks Starter+** para acceso al WS de aggregates realtime; el free tier sólo da REST end‑of‑day.                                                                                              |
| **TwelveData**    | Bootstrap histórico de barras     | Signup en `twelvedata.com` → API Key. Free = 8 req/min (alcanza para watchlists chicas). Plan pagado para mayor concurrencia — ajustar `TWELVEDATA_MIN_INTERVAL_MS` a `400` (155/min).                                                            |
| **ChartsWatcher** | Feed de scanner                   | Cuenta en `chartswatcher.com` → settings → `User ID` + `API Key`. Los `cwConfigId` de cada estrategia están hardcoded en `adaptersSetup.ts` — si tu cuenta no tiene esos scanners, crearlos y reemplazar los IDs.                                 |
| **BetterStack**   | Heartbeat + Logtail (opcional)    | `betterstack.com` → Heartbeats (URL) y Telemetry → Logtail source token.                                                                                                                                                                          |
| **Grafana Cloud** | Métricas remote‑write (opcional)  | `grafana.com` → free tier → My Account → Prometheus → endpoint URL + username + API key.                                                                                                                                                          |

#### Mintear el refresh token de TradeStation

```bash
pnpm oauth:refresh-token
```

Levanta un server local en `http://localhost:3001` (configurable con
`OAUTH_REDIRECT_PORT`), abre el navegador para que loguees con tu cuenta de
TradeStation, intercepta el callback OAuth, intercambia el code y te imprime
el `refresh_token`. Pegarlo en `.env` como `TRADESTATION_REFRESH_TOKEN`. Una
vez seteado, el bot lo refresca en memoria automáticamente — no debería
volverse a correr salvo que se revoque o caduque por inactividad.

### 5. Configurar `.env`

```bash
cp .env.example .env
# completar las variables (ver tabla en la siguiente sección)
```

Generar un `API_TOKEN` con `openssl rand -hex 32` y pegarlo si vas a
consumir las rutas `/api/*` desde un cliente HTTP.

### 6. Correr

```bash
pnpm dev          # hot reload + auto-load de .env
```

`tsx watch` reinicia ante cambios en `src/`. Validar que arranca:

```bash
curl http://localhost:3000/health
# → {"status":"ok","uptime":<n>}
```

Si seteaste `API_TOKEN`:

```bash
curl -H "Authorization: Bearer <tu_token>" http://localhost:3000/api/watchlist
```

### 7. (Opcional) Skip del trading loop

Para levantar la API sin disparar el loop de decisión / órdenes reales:

```bash
# .env
DECISION_ENABLED=false
```

El bot expone igualmente `/health`, `/metrics`, watchlist y streams del
broker (read‑only). Útil para diagnóstico, pruebas de endpoints o sandbox.

## Variables de entorno

Validadas al arranque por `requireEnv()` en `main.ts`. Valores faltantes en
las **Requeridas** rompen el boot con un error explícito.

### Servidor

| Variable    | Requerida | Default   | Propósito                                               |
| ----------- | --------- | --------- | ------------------------------------------------------- |
| `PORT`      | no        | `3000`    | Puerto HTTP                                             |
| `HOST`      | no        | `0.0.0.0` | Interface bind                                          |
| `NODE_ENV`  | no        | —         | `development` / `production`                            |
| `LOG_LEVEL` | no        | `info`    | `debug` / `info` / `warn` / `error`                     |
| `TZ`        | no        | —         | Forzado a `UTC` en `render.yaml`                        |
| `API_TOKEN` | no\*      | —         | Bearer para `/api/*`. Si está vacío → `503` fail‑closed |

\* No requerido para arrancar, pero sin él todo `/api/*` devuelve 503.

### Broker — TradeStation

| Variable                     | Requerida | Default                            | Propósito                                      |
| ---------------------------- | --------- | ---------------------------------- | ---------------------------------------------- |
| `TRADESTATION_CLIENT_ID`     | **sí**    | —                                  | OAuth client ID                                |
| `TRADESTATION_CLIENT_SECRET` | sí\*      | `''`                               | OAuth client secret (sólo para refresh)        |
| `TRADESTATION_REFRESH_TOKEN` | **sí**    | —                                  | Refresh token (ver `pnpm oauth:refresh-token`) |
| `TRADESTATION_ACCOUNT_ID`    | **sí**    | —                                  | Cuenta. Prefijo `SIM` → simulador              |
| `TRADESTATION_SIM_URL`       | no        | `https://sim.api.tradestation.com` |                                                |
| `TRADESTATION_LIVE_URL`      | no        | `https://api.tradestation.com`     |                                                |
| `TRADESTATION_SIGNIN_URL`    | no        | `https://signin.tradestation.com`  | Sólo lo usa el script OAuth                    |

\* `CLIENT_SECRET` no está en `requireEnv` (cae a `''`), pero el refresh
de tokens necesita el secret para funcionar.

### Market data — Polygon (realtime)

| Variable          | Requerida | Default                          | Propósito                              |
| ----------------- | --------- | -------------------------------- | -------------------------------------- |
| `POLYGON_API_KEY` | **sí**    | —                                | WebSocket auth                         |
| `POLYGON_WS_URL`  | no        | `wss://socket.polygon.io/stocks` | Endpoint canal AM (aggregate minute)   |
| `BOOTSTRAP_BARS`  | no        | `200`                            | Barras a backfillear por símbolo nuevo |

### Market data — TwelveData (histórico)

| Variable                     | Requerida | Default                      | Propósito                                              |
| ---------------------------- | --------- | ---------------------------- | ------------------------------------------------------ |
| `TWELVEDATA_API_KEY`         | **sí**    | —                            | REST auth                                              |
| `TWELVEDATA_BASE_URL`        | no        | `https://api.twelvedata.com` |                                                        |
| `TWELVEDATA_MIN_INTERVAL_MS` | no        | `7500`                       | Rate limiter (free: 7500 = 8/min; paid 155/min: `400`) |

### Scanner — ChartsWatcher

| Variable     | Requerida | Default                                        | Propósito   |
| ------------ | --------- | ---------------------------------------------- | ----------- |
| `CW_USER_ID` | **sí**    | —                                              | User ID     |
| `CW_API_KEY` | **sí**    | —                                              | API key     |
| `CW_WS_URL`  | no        | `wss://app.chartswatcher.com/api/v1/websocket` | Endpoint WS |

### Persistencia

| Variable    | Requerida | Default | Propósito                                   |
| ----------- | --------- | ------- | ------------------------------------------- |
| `REDIS_URL` | **sí**    | —       | Watchlist + trade context + cache de barras |

### Decision loop

| Variable           | Requerida | Default | Propósito                                                  |
| ------------------ | --------- | ------- | ---------------------------------------------------------- |
| `DECISION_ENABLED` | no        | `true`  | `false` desactiva `BarStreamManager` (API up, trading off) |

### Observabilidad (todas opcionales)

| Variable                      | Default | Propósito                                                                                  |
| ----------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `LOGTAIL_SOURCE_TOKEN`        | —       | Envío de logs a Logtail (BetterStack)                                                      |
| `BETTERSTACK_HEARTBEAT_URL`   | —       | Ping a Better Uptime sólo durante RTH                                                      |
| `GRAFANA_CLOUD_PROM_URL`      | —       | Remote‑write Prometheus. Las 3 vars deben estar seteadas; si falta una → métricas locales. |
| `GRAFANA_CLOUD_PROM_USERNAME` | —       |                                                                                            |
| `GRAFANA_CLOUD_PROM_API_KEY`  | —       |                                                                                            |

### Legacy / reservadas

`ALPHA_VANTAGE_API_KEY`, `ALPHA_VANTAGE_BASE_URL`,
`ALPHA_VANTAGE_MIN_INTERVAL_MS` están en `env.ts` y `.env.example` pero el
adapter no se wirea en `main.ts` (queda para comparación contra
`LocalIndicatorAdapter` si se necesita).

## Scripts

### npm scripts

| Script                              | Acción                                                |
| ----------------------------------- | ----------------------------------------------------- |
| `pnpm dev`                          | `tsx watch --env-file=.env src/main.ts` (hot reload)  |
| `pnpm build`                        | `tsc` → emite a `dist/`                               |
| `pnpm start`                        | `node dist/main.js` (requiere build previo)           |
| `pnpm test`                         | `vitest run` (tests en `src/**/tests/`)               |
| `pnpm test -- path/to/file.test.ts` | Un único archivo de test                              |
| `pnpm test -- -t "name"`            | Filtra por patrón en el `describe/it`                 |
| `pnpm lint` / `pnpm lint:fix`       | ESLint sobre el repo                                  |
| `pnpm format` / `pnpm format:check` | Prettier write / check                                |
| `pnpm oauth:refresh-token`          | Flujo OAuth de TradeStation → imprime `refresh_token` |
| `pnpm redis:flush`                  | `FLUSHDB` sobre `REDIS_URL` (cuidado en prod)         |

Pre‑commit (Husky + lint‑staged) corre `eslint --fix --max-warnings=0` +
`prettier --write` sobre los staged. No bypassear con `--no-verify` salvo
pedido explícito.

### Scripts en `scripts/`

Se corren con `tsx --env-file=.env scripts/<nombre>.ts` y comparten el `.env`
con el bot.

| Script                 | Propósito                                                                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get-refresh-token.ts` | Lo que corre `pnpm oauth:refresh-token`. Levanta server en `localhost:3001` (configurable `OAUTH_REDIRECT_PORT`).                                                                                                    |
| `flush-redis.ts`       | Lo que corre `pnpm redis:flush`.                                                                                                                                                                                     |
| `probe-polygon.ts`     | `tsx --env-file=.env scripts/probe-polygon.ts AAPL` — recibe N segundos de barras AM y las imprime. Útil para validar conectividad y formato. `PROBE_SYMBOL`, `PROBE_DURATION_MS` (default 180000).                  |
| `probe-ts-stream.ts`   | `tsx --env-file=.env scripts/probe-ts-stream.ts orders 15` — dumpea el HTTP stream de orders o positions de TradeStation durante N segundos. Útil para inspeccionar delimitadores, heartbeats y formato de snapshot. |

## API HTTP

`registerAuthMiddleware` (`src/infrastructure/http/authMiddleware.ts`) gatea
todo `/api/*` con Bearer token vía `Authorization: Bearer <token>` o
`?token=<token>` (workaround para SSE en navegadores que no permiten headers
en `EventSource`). Si `API_TOKEN` no está seteado, todo `/api/*` devuelve
**503** (fail‑closed). Comparación con `timingSafeEqual`.

### Endpoints públicos

| Método | Path            | Descripción                                                                                                                      |
| ------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/health`       | Liveness simple. `{ status: "ok", uptime }`.                                                                                     |
| GET    | `/health/ready` | Readiness con checks de scanner, freshness del feed, Redis ping y token del broker. Responde `503` si algún check crítico falla. |
| GET    | `/metrics`      | Exposición Prometheus (`text/plain; version=0.0.4`).                                                                             |

### Endpoints protegidos (`/api/*`)

| Método | Path                           | Descripción                                                                  |
| ------ | ------------------------------ | ---------------------------------------------------------------------------- |
| GET    | `/api/watchlist`               | Lista símbolos agrupados por estrategia.                                     |
| GET    | `/api/broker/orders`           | Órdenes abiertas en el broker (cruzadas contra el `TradeContextRepository`). |
| GET    | `/api/broker/stream/orders`    | **SSE** con eventos `order` y `connection`. Heartbeat `: ping` cada 15s.     |
| GET    | `/api/broker/stream/positions` | **SSE** con eventos `position` y `connection`. Heartbeat `: ping` cada 15s.  |

Ejemplo SSE desde un navegador (no se puede mandar header `Authorization`):

```js
const es = new EventSource(`/api/broker/stream/orders?token=${API_TOKEN}`);
es.addEventListener('order', (e) => console.log(JSON.parse(e.data)));
es.addEventListener('connection', (e) => console.log(JSON.parse(e.data)));
```

## Observabilidad

### Métricas Prometheus (las más relevantes)

| Métrica                            | Tipo      | Labels             | Qué cuenta                                       |
| ---------------------------------- | --------- | ------------------ | ------------------------------------------------ |
| `decisions_total`                  | counter   | `symbol`, `action` | Decisiones evaluadas (`buy` / `hold`)            |
| `decision_runner_ticks_total`      | counter   | `outcome`          | Ticks de `BarStreamManager`                      |
| `orders_total`                     | counter   | `status`           | Órdenes enviadas al broker, por status           |
| `tradestation_request_duration_ms` | histogram | —                  | Latencia HTTP a TradeStation                     |
| `tradestation_errors_total`        | counter   | `type`             | Errores categorizados (auth / network / invalid) |
| `oauth_refresh_total`              | counter   | `result`           | Refreshes de access token                        |
| `watchlist_size`                   | gauge     | —                  | Símbolos activos                                 |
| `scanner_ws_connected`             | gauge     | —                  | 0 / 1 estado del WS de CW                        |
| `market_feed_ws_connected`         | gauge     | —                  | 0 / 1 estado del WS de Polygon                   |
| `bars_received_total`              | counter   | —                  | Barras 1‑min recibidas del feed                  |
| `bar_dedup_skips_total`            | counter   | —                  | Barras duplicadas descartadas                    |
| `bootstrap_failures_total`         | counter   | —                  | Fallos al traer histórico desde TwelveData       |

### Heartbeat

Si `BETTERSTACK_HEARTBEAT_URL` está seteado, se levanta `Heartbeat`
(`src/application/heartbeat/Heartbeat.ts`). Pingea sólo durante RTH y se
saltea si el feed está stale (>3 min sin barra) para no enmascarar un feed
caído.

### Grafana Cloud

Si las tres `GRAFANA_CLOUD_PROM_*` están presentes, `GrafanaCloudWriter`
hace remote‑write del registry de Prometheus a Grafana Cloud. Las métricas
quedan disponibles localmente igualmente en `/metrics`.

### Logs

`pino` con pretty print en dev. En prod, si `LOGTAIL_SOURCE_TOKEN` está
seteado, los logs viajan también a Logtail (BetterStack).

## Deploy

### Render (deploy actual)

[`render.yaml`](./render.yaml) es un blueprint de Render. Características
fijadas:

- **Tipo**: `web` con runtime Docker (usa el `Dockerfile` del repo).
- **Plan**: `starter` ($7/mo). No suspende en idle — el bot mantiene WS
  abierto y necesita ticks ~cada minuto, el plan free lo dormiría.
- **Región**: `ohio` (us‑east) — baja latencia al datacenter NJ de TradeStation.
- **Branch**: `main` con `autoDeploy: true`. Recomendado dejar el toggle
  "Auto‑Deploy: After CI Checks Pass" activo en el dashboard.
- **Healthcheck**: `/health`.
- **`numInstances: 1`** (crítico). El bot es stateful: la watchlist, los
  inFlight Sets del DecisionRunner y las suscripciones WS no son
  duplicables. **No habilitar autoscaling.**
- **Secrets**: las env vars con `sync: false` se setean manualmente en el
  dashboard de Render (no van a git).
- **Redis**: externo en Upstash (free tier 10k commands/día). Pegar la
  connection string como `REDIS_URL`.

Cualquier env var nueva (ej. `GRAFANA_CLOUD_PROM_URL`) hay que agregarla
al blueprint o setearla a mano en el dashboard.

### Docker (alternativa local / portable)

Multi‑stage en [`Dockerfile`](./Dockerfile): `deps` → `build` → `runtime`
sobre `node:20-alpine`, drop al user no‑root `app`, `EXPOSE 3000`,
`CMD ["node", "dist/main.js"]`.

```bash
docker build -t cw-bot .
docker run --rm -p 3000:3000 --env-file .env cw-bot
```

## Convenciones de código

Resumen — detalle exhaustivo en [`CLAUDE.md`](./CLAUDE.md):

- **Hexagonal estricto**: `domain/` puro, `application/` use cases, `infrastructure/` adapters. Domain no importa de infra.
- **Imports ESM con `.js`** intra‑repo (`module: ESNext`, `moduleResolution: bundler`).
- **Tests inline** bajo `src/**/tests/`, no en la raíz.
- **Inputs en el Port**, no en un archivo aparte. Entidades sin sufijo `Value`.
- **Sin ternarios anidados** — extraer a helper con nombre o usar `if` / early return.
- **Env vars sólo para secrets, URLs externas, IDs y toggles.** Parámetros del modelo (budget, %, bps) van como `DEFAULT_PARAMS` en el adapter, no en env.
- **Commits**: nunca crear un commit sin OK explícito del usuario para ese commit puntual. Sin trailer de `Co-Authored-By`.

## Troubleshooting

| Síntoma                                                     | Probable causa                                                                                                  |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `401 Unauthorized` al pegar a `/api/*`                      | Bearer faltante o no coincide con `API_TOKEN`.                                                                  |
| `503` con `api token not configured (fail-closed)`          | `API_TOKEN` no seteado — sin él el bot rechaza todo `/api/*` por seguridad.                                     |
| El bot arranca pero no opera                                | `DECISION_ENABLED=false`, o mercado fuera de RTH, o el feed de Polygon está stale (revisar `/health/ready`).    |
| `Missing required env vars: …` al arrancar                  | Faltan vars validadas por `requireEnv()` — ver [Variables de entorno](#variables-de-entorno).                   |
| Errores `oauth_refresh_total{result="failure"}` recurrentes | Refresh token revocado o caducado — re‑correr `pnpm oauth:refresh-token`.                                       |
| No llegan barras                                            | `pnpm tsx --env-file=.env scripts/probe-polygon.ts AAPL` para aislar Polygon. Verificar plan (Stocks Starter+). |
| `bootstrap_failures_total` crece                            | TwelveData rate‑limit. Subir el plan o aumentar `TWELVEDATA_MIN_INTERVAL_MS`.                                   |
| Streams SSE se desconectan tras 30s detrás de un proxy      | El proxy está bufferando. Verificar que respeta `X-Accel-Buffering: no` o ajustar el proxy.                     |
| Trade abierto pero `breakEvenMoved` nunca se setea          | Estrategia sin `trailToBreakEvenAtProfit` o profit aún bajo umbral. Revisar `adaptersSetup.ts`.                 |

## Referencias

- [`CLAUDE.md`](./CLAUDE.md) — convenciones de código, naming hexagonal, comportamientos no‑obvios del adapter de TradeStation.
- [`render.yaml`](./render.yaml) — blueprint de deploy.
- [`Dockerfile`](./Dockerfile) — imagen runtime.
- Docs externas: [TradeStation API](https://api.tradestation.com/docs/), [Polygon WS](https://polygon.io/docs/websocket), [TwelveData REST](https://twelvedata.com/docs), [ChartsWatcher](https://chartswatcher.com/).
