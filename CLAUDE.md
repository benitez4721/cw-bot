# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Package manager: **pnpm**. Module type: **ESM** (`"type": "module"`).

| Command                             | Action                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------ |
| `pnpm dev`                          | `tsx watch --env-file=.env src/main.ts` — hot reload + auto-loads `.env` |
| `pnpm build`                        | `tsc` → emits to `dist/`                                                 |
| `pnpm start`                        | `node dist/main.js` (requires prior `pnpm build`)                        |
| `pnpm test`                         | `vitest run` (tests live inline under `src/**/tests/`)                   |
| `pnpm test -- path/to/file.test.ts` | Run a single test file                                                   |
| `pnpm test -- -t "name"`            | Run a single test by name pattern                                        |
| `pnpm lint` / `pnpm lint:fix`       | ESLint over the repo                                                     |
| `pnpm format` / `pnpm format:check` | Prettier write / check                                                   |
| `pnpm oauth:refresh-token`          | Helper to mint a TradeStation refresh token                              |
| `pnpm redis:flush`                  | Flush the configured Redis DB                                            |

A `pre-commit` hook (husky + lint-staged) runs `eslint --fix --max-warnings=0` and `prettier --write` on staged files. Don't bypass it with `--no-verify` unless explicitly asked.

TypeScript is `strict` with `target: ES2022`, `module: ESNext`, `moduleResolution: bundler`.

## Architecture

Hexagonal (ports & adapters):

```
src/
  domain/         Pure types + port interfaces. No I/O, no framework deps.
                  Subdomains: broker, decision, indicators, market,
                  marketdata, metrics, scanner, trade, watchlist.
  application/    Use cases (one class per file). Depend on domain ports only.
                  Subdomains: broker, heartbeat, marketdata, orderstream,
                  positionstream, trade, watchlist.
  infrastructure/ Adapters implementing the ports + Fastify wiring + env config
                  + logging + metrics writers.
  adaptersSetup.ts  Builds every concrete adapter (Redis, TradeStation,
                  Polygon, TwelveData, ChartsWatcher, Prometheus, …) and
                  returns them as a single `Adapters` bag. Also declares
                  the `ConfiguredStrategy` list (decision model + its
                  watchlist + CW scanner config_id).
  main.ts         Composition root: calls `setupAdapters()`, instantiates
                  use cases and managers (BarStreamManager,
                  OrderStreamManager, PositionStreamManager, Heartbeat,
                  GrafanaCloudWriter, ScannerMonitor per strategy),
                  registers Fastify routes, wires shutdown.
```

Tests live next to the code they cover, under a `tests/` subfolder in each
layer (e.g. `src/domain/tests/`, `src/application/tests/`,
`src/infrastructure/tests/`), not at the repo root.

### Key contracts

- **`domain/broker/BrokerPort.ts`** — the abstraction every broker integration must implement: `placeBracketOrder`, `getPositions`, `getOrders`, `getQuote`, `replaceStopPrice`, `cancelOrder`, `placeMarketOrder`, `placeTrailingBracketOrder`. Entry + bracket exits (stop/take-profit) are submitted as a single OSO/BRK payload — the port is intentionally bracket-shaped, not generic. Bracket exits are managed by the broker once submitted, and stop adjustments go through `replaceStopPrice`. **Every input requires `accountId: string`** — the port is account-agnostic, each call routes to the cuenta indicada (no default implícito).
- **`domain/broker/BrokerTypes.ts`** — canonical, broker-agnostic shapes (`OrderStatus`, `OrderType`, `OrderSide`, `Order`, `Position`, `Quote`, `BracketOrderInput`, `BracketOrderResult`). Adapters translate vendor strings into these enums.
- **`domain/broker/OrderStreamPort.ts` / `PositionStreamPort.ts`** — push-stream ports for live order + position updates. Each stream instance está bound a UN account (los websockets de TS son por cuenta); el composition root crea N stream adapters + N managers (uno por accountId distinto declarado por las estrategias). `OrderEvent` y `PositionEvent` llevan `accountId: string` para que el consumer pueda distinguir.
- **`domain/decision/DecisionModel.ts` + `DecisionStrategy.ts`** — un `DecisionStrategy` bundles a `DecisionModel`, una `WatchlistRepository`, opcionalmente `trailToBreakEvenAtProfit`, y un **`accountId` obligatorio** (cuenta TradeStation contra la que opera). Concrete models live in `domain/decision/models/` (`MacdM1CrossOverDecisionModel`, `SuperDecisionModel`); cada modelo recibe `accountId` por constructor para resolver `getQuote`. `EventStrategy` (event-driven, sin DecisionModel) también declara `accountId` obligatorio.
- **`domain/marketdata/`** — `MarketFeedPort` (live bars push), `HistoricalBarsPort` (REST backfill), `BarRepository` (persistence). The bar stream manager bootstraps from `BarRepository` ∪ `HistoricalBarsPort`, then keeps the rolling window fresh from `MarketFeedPort`.
- **`domain/scanner/ScannerFeedPort.ts`** — push feed of symbols entering / leaving a scanner config. Each strategy points at its own CW `config_id`, so watchlists stay decoupled.
- **`domain/indicators/IndicatorPort.ts`** — indicator computation (MACD, EMA, …). The default adapter is `LocalIndicatorAdapter`, which computes from `BarRepository`; remote adapters (`TwelveDataIndicatorAdapter`, `AlphaVantageIndicatorAdapter`) exist for backfill/comparison.
- **`domain/market/MarketHours.ts`** — US market hours (RTH boundaries, holiday calendar). `UsMarketHoursAdapter` implements it.
- **`domain/metrics/MetricsPort.ts`** — counter/gauge/histogram surface used by adapters and use cases. The Prometheus implementation lives in `infrastructure/metrics/`; `GrafanaCloudWriter` does remote-write of the same registry.
- **`domain/trade/TradeContextRepository.ts`** — persistence for per-trade context (decision snapshot, original stop/TP, lifecycle state). Redis-backed.
- **`domain/watchlist/WatchlistRepository.ts`** — per-strategy symbol set. Multiple instances coexist behind distinct Redis `keyPrefix` values.

### Fastify routes

Wired in `main.ts`:

- `healthRoutes` — `/health` liveness + dependency status.
- `metricsRoutes` — `/metrics` Prometheus text exposition.
- `watchlistRoutes` — list per-strategy watchlists.
- `brokerRoutes` — `GET /api/broker/orders` via the `GetOrders` use case.
- `brokerStreamRoutes` — WS surface backed by `OrderStreamManager` + `PositionStreamManager`.

`registerAuthMiddleware` gates the `/api/` prefix with `API_TOKEN` (Bearer). Anything outside `/api/` is unauthenticated.

### Adapter naming and folder convention

Adapters are grouped by **vendor** when the vendor implements multiple ports
or carries shared vendor-only state (HTTP client, OAuth, rate limiter,
streaming connection, response mappers). Single-port vendors with no shared
state live directly under the port folder.

- **Vendor folder** — when the vendor implements 2+ ports OR ships shared
  vendor-only state. Everything related to the vendor (adapters + client +
  shared helpers) lives in `infrastructure/<vendor>/`.
  - TradeStation implements `BrokerPort`, `OrderStreamPort` and
    `PositionStreamPort` + shared OAuth/HTTP client + streaming connection +
    response mappers → `infrastructure/broker/tradestation/` contains
    `TradeStationBrokerAdapter.ts`, `TradeStationOrderStreamAdapter.ts`,
    `TradeStationPositionStreamAdapter.ts`, `TradeStationClient.ts`,
    `TradeStationStreamConnection.ts`, `tradeStationMapping.ts`.
    The vendor folder lives under `broker/` (its primary port) to leave
    room for future broker vendors next to it (e.g.
    `infrastructure/broker/ibkr/`). Order/position streams are TradeStation-
    specific facets of the same broker, so they ride along in the same folder.

- **Port folder** — when the vendor implements a single port and has no
  shared state. The adapter lives directly under the port folder.
  - `PolygonMarketFeedAdapter` implements `MarketFeedPort` → `infrastructure/marketdata/`.
  - `ChartsWatcherScannerFeedAdapter` implements `ScannerFeedPort` → `infrastructure/scanner/`.
  - `AlphaVantageIndicatorAdapter` / `LocalIndicatorAdapter` implement `IndicatorPort` → `infrastructure/indicators/`.
  - `UsMarketHoursAdapter` implements `MarketHours` → `infrastructure/market/`.

- **Naming**:
  - Adapters: `<Vendor><Puerto>Adapter.ts`. The class name matches the filename.
  - The `Adapter` suffix is kept even when the port name already appears in
    the class (e.g. `UsMarketHoursAdapter`) to keep the convention uniform.
  - Repositories (DDD): `<Vendor><Entidad>Repository.ts`. The `Repository`
    suffix already identifies the port, so no extra `Adapter` is needed.
    Examples: `RedisBarRepository`, `RedisTradeContextRepository`,
    `RedisWatchlistRepository`.

- **One adapter per port per file**. If a vendor implements two ports, split
  into one adapter class per port, both in the vendor folder.

**Known exception**: Twelve Data has a shared HTTP client / rate limiter
(`infrastructure/twelvedata/TwelveDataClient.ts`) but its adapters still
live under the port folders
(`infrastructure/indicators/TwelveDataIndicatorAdapter.ts`,
`infrastructure/marketdata/TwelveDataHistoricalBarsAdapter.ts`). The client
already moved to the vendor folder; full migration of the adapters is
pending.

### Import convention (ESM)

All intra-repo imports must include the `.js` extension even though the source is `.ts` (required because `module: ESNext` + `moduleResolution: bundler` emits ESM that resolves `.js` at runtime). Example: `import { PlaceBracketOrder } from './application/broker/PlaceBracketOrder.js'`.

### TradeStation adapter — non-obvious behaviors

- **Multi-account architecture**: una sola instancia de `TradeStationClient` y una sola de `TradeStationBrokerAdapter` cubren todas las cuentas configuradas. El `client` no guarda `accountId`; `apiBase(accountId)` y `request({..., accountId})` lo reciben per-call. Cada estrategia declara su `accountId` y el adapter lo lee desde el input — no hay fallback.
- **Sim vs Live routing** is decided per-request by `accountId.startsWith('SIM')` adentro de `TradeStationClient.apiBase(accountId)`. The same adapter handles both; there is no separate sim/live build.
- **Streams son por cuenta**: el endpoint `/v3/brokerage/stream/accounts/{accountId}/{orders,positions}` requiere una conexión websocket por cuenta. `adaptersSetup` construye un `TradeStationOrderStreamAdapter` y un `TradeStationPositionStreamAdapter` por accountId (compartiendo el mismo `TradeStationClient`); `main.ts` instancia un manager por accountId. `brokerStreamRoutes` recibe `ReadonlyMap<accountId, Manager>` y hace fan-out en cada conexión SSE.
- **OAuth access tokens** are cached in memory with a refresh margin. Concurrent requests share a single in-flight refresh via `refreshPromise` (single-flight pattern) — preserve this when modifying `getAccessToken`/`refreshSession` in `TradeStationClient`. La sesión OAuth se comparte entre cuentas (el refresh token es del OAuth app, no del account).
- **Bracket payload shape**: `placeBracketOrder` submits a single Limit entry order with an OSO (`Type: 'BRK'`) holding two GTC exit legs (`StopMarket` + `Limit`). Stop/TP prices are computed off `entryLimitPrice` as a proxy for the fill — if the fill is better, exit offsets end up asymmetric in cents (accepted for v1, see comment in source).
- **Status mapping**: TradeStation 3-letter status codes (`ACK`, `OPN`, `FLL`, `FPR`, `CAN`, `OUT`, `REJ`, `BRO`, `EXP`) map to the domain `OrderStatus` enum via `mapStatus` in `tradeStationMapping.ts`. Unknown codes default to `'pending'`.
- **Leg detection in `getOrders`**: the adapter cross-references `OrderType` + `LimitPrice` / `StopPrice` against the bracket's computed `cost` / `takeProfitPrice` / `stopPrice` to classify each open order as entry / TP / stop. Keep this aligned with the payload shape produced by `placeBracketOrder`.
- **Error shape**: TradeStation may return HTTP 200 with `{ Orders: [{ Error: 'FAILED', ... }] }`. The adapter checks for `Error === 'FAILED'` and returns a `rejected` `BracketOrderResult` rather than throwing — preserve that contract for callers.

## Code conventions

### Stay close to the data

If an operation can be expressed as a `find` / `filter` / `some` over the array
that already holds the information, don't build a `Record` / `Map` to index it
nor an intermediate accumulator to "organize" before reading. Justify indexing
with a concrete reason (repeated lookups in a large set, joins across sources
that can't be collapsed). For small arrays (≲20 items) a linear `find` is
readable and fast — a `Record` keyed by id to do three lookups is accidental
complexity, not performance.

When two sources carry the same datum (typical: POST returns `OrderID` + a
textual message, GET returns `OrderID` + the full state), don't cross them
"just in case" — keep the richer source and drop the other.

### Hexagonal naming

- `*Input` types (use-case / port inputs) live in the **port** file (`<Module>Port.ts`), not in a separate file.
- Entity / value types live in `<Module>Types.ts` and use their direct name (`EMA`, not `EMAValue`; `Quote`, not `QuoteValue`).

### Env vars vs model params

Env is for secrets, external URLs / IDs, and runtime toggles (`API_TOKEN`,
`POLYGON_API_KEY`, `DECISION_ENABLED`). Model parameters (risk budget,
percentages, basis-points thresholds) are not env — they live as
`DEFAULT_PARAMS` constants in the decision model / adapter file, so they
move with the code that uses them and stay reviewable in diffs.

### No nested ternaries

Extract to a named helper or use `if` / early-return. At most one `?:` per
expression.

## Configuration

Env loaded via `tsx --env-file=.env` (dev) or process env (prod). See
`src/infrastructure/config/env.ts` for the full list and defaults.

Required at startup (checked by `requireEnv()` in `main.ts`):
`REDIS_URL`, `TRADESTATION_CLIENT_ID`, `TRADESTATION_REFRESH_TOKEN`,
`TRADESTATION_ACCOUNT_ID`, `POLYGON_API_KEY`, `TWELVEDATA_API_KEY`,
`CW_USER_ID`, `CW_API_KEY`. Missing values throw before the server binds.

`TRADESTATION_ACCOUNT_ID` se usa hoy como bootstrap de la cuenta que las
estrategias hardcodeadas en `adaptersSetup.ts` declaran (cada `accountId`
es obligatorio en `DecisionStrategy` / `EventStrategy`). Si querés rutear
una estrategia a otra cuenta, cambia el valor de `accountId` en esa
strategy en `adaptersSetup.ts` — el composition root abre un websocket
por cada accountId distinto automáticamente.

Optional toggles worth knowing:

- `API_TOKEN` — Bearer token gating the `/api/` prefix. If unset, auth is
  disabled (dev only — don't ship that way).
- `DECISION_ENABLED` (default `true`) — when `false`, `BarStreamManager` is
  not started, so no decisions run. Useful for read-only deploys.
- `BOOTSTRAP_BARS` (default `200`) — rolling window size pulled from
  `HistoricalBarsPort` on startup per symbol.
- `BETTERSTACK_HEARTBEAT_URL` — when set, the `Heartbeat` use case pings it
  during RTH only.
- `GRAFANA_CLOUD_PROM_URL` / `GRAFANA_CLOUD_PROM_USERNAME` /
  `GRAFANA_CLOUD_PROM_API_KEY` — when all three are set, the Prometheus
  registry is remote-written to Grafana Cloud.
- `POSTGRES_URL` — when set, enables capture of raw ChartsWatcher alerts to
  Postgres via `ScannerAlertRecorder` (append-only log for backtesting
  EventStrategies). Fire-and-forget: the bot starts fine without it
  (`alertCapture: disabled`) and a capture failure never affects trading.
  Schema is created out-of-band by `pnpm db:init-scanner-alerts`.

## Scripts

Maintenance / operational scripts live under `scripts/` and are run with
`tsx --env-file=.env`. They share the same env + adapters as the server,
so they require the same credentials. Examples:

- `scripts/get-refresh-token.ts` — OAuth helper.
- `scripts/flush-redis.ts` — wipe the configured Redis DB.
- `scripts/probe-polygon.ts` / `scripts/probe-ts-stream.ts` — manual stream probes.

## API surface

See `README.md` for the endpoint table. Routes under `/api/` are gated by `API_TOKEN`; the rest are public — still, bind to localhost or place behind a trusted reverse proxy.

## Commits

Never create a commit without an explicit prior approval from the user for the specific commit being made. Phrases like "commit this", "commitea esto", "go ahead and commit" authorize ONE commit for the change currently on the table — they do not pre-authorize follow-up commits, even when continuing the same task. When in doubt, stop and ask. Running tests/typecheck and staging files is fine; running `git commit` is not, until the user has said so for the change at hand.

Never add the `Co-Authored-By` trailer (or any other co-author/attribution trailer) to commit messages.
