# cw-bot

Automated trading bot. Currently exposes a HTTP API on top of a broker integration (TradeStation).

## Stack

- Fastify 5 (ESM)
- TypeScript 5 (strict, ES2022)
- Hexagonal layout: `domain/`, `application/`, `infrastructure/`
- pnpm

## Setup

```bash
pnpm install
cp .env.example .env
# fill in TRADESTATION_* credentials
pnpm dev
```

## Scripts

| Script | Action |
|--------|--------|
| `pnpm dev` | Start with tsx watch + .env auto-load |
| `pnpm build` | Compile TypeScript to `dist/` |
| `pnpm start` | Run compiled output (`dist/main.js`) |
| `pnpm test` | Run vitest |

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health probe |
| POST | `/api/broker/orders` | Place order |
| PUT | `/api/broker/orders/:orderId` | Replace order |
| DELETE | `/api/broker/orders/:orderId` | Cancel order |
| GET | `/api/broker/orders?symbol=` | List active orders |
| GET | `/api/broker/orders/historical?since=` | Historical orders |
| GET | `/api/broker/balances` | Account balances |
| GET | `/api/broker/positions` | Open positions |

Account environment (sim vs live) is detected from the `TRADESTATION_ACCOUNT_ID` prefix (`SIM*` → simulator).

## Notes

No auth — bind to localhost or place behind a trusted reverse proxy.
