# Deliver API

Backend for the Deliver platform: a customer mobile app, a driver mobile app, and
(later) an admin dashboard, all served by one delivery domain.

NestJS 12 (ESM) · Prisma 7 · PostgreSQL · Redis · BullMQ · Socket.IO · MinIO/S3

## Getting started

```bash
npm install                 # postinstall runs `prisma generate`
npm run infra:up            # Redis on 6380, MinIO on 9000/9001
cp .env.example .env        # then fill in the secrets — see below
createdb deliver_new
npm run db:deploy           # apply migrations
npm run start:dev
```

- API: <http://localhost:3000/api/v1>
- Swagger: <http://localhost:3000/api/docs>
- Health: <http://localhost:3000/health>

### Secrets you must set

```bash
openssl rand -base64 48     # JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, ENCRYPTION_KEY
```

`MAP_API_KEY` is the RokTenh map key (raw value — the provider does **not** use a
`Bearer` prefix). The app refuses to boot if any required variable is missing or
malformed; see `src/config/env.validation.ts` for the full contract.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run start:dev` | Watch mode |
| `npm run build` | Compile to `dist/` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | oxlint |
| `npm test` | Unit tests (vitest) |
| `npm run test:e2e` | e2e against the `deliver_new_test` database |
| `npm run check` | typecheck + lint + unit tests |
| `npm run db:migrate` | Create and apply a migration |
| `npm run db:reset` | Drop and rebuild the dev database |
| `npm run db:studio` | Prisma Studio |

### Test database

e2e tests boot the real application against `deliver_new_test` and Redis DB 1,
truncating between specs. Create it once:

```bash
createdb deliver_new_test
npm run db:test:deploy
```

## Conventions

**ESM.** Every relative import ends in `.js` (`import { X } from './x.js'`), and
injected classes are imported as values, never with `import type`.

**Money.** Integers in the currency's minor unit, always beside an explicit
`Currency`. KHR has scale 0 (1 = 1 riel), USD scale 2. Percentages are integer
basis points. Use `MoneyUtil`; never `Float`, never a bare number.

**Responses.** Controllers return plain data. `ResponseInterceptor` wraps it:

```json
{ "success": true, "code": "DELIVERY_CREATED", "message": "…", "data": {}, "meta": null }
```

Declare the code with `@ResponseCode(ResponseCode.DELIVERY_CREATED)`. Return a
`PaginatedResult` and its `meta` is lifted into the envelope automatically.

**Errors.** Throw `AppException` — never `HttpException` — so every failure has a
machine-readable `code` that clients can branch on. Add new codes to
`src/common/constants/response-codes.ts`.

**Authorisation.** The JWT guard is global: routes are private unless marked
`@Public()`. `@Roles()` is a coarse gate; services must still verify that the row
belongs to the caller. Never trust an id from a client.

**Status changes.** Only `DeliveryStateService` writes `Delivery.status`, and every
accepted transition writes `DeliveryStatusHistory` in the same transaction.

**Redis vs Postgres.** Redis holds what is only true right now (OTPs, presence,
live GPS, locks, rate limits, map cache). Postgres holds anything a customer could
dispute.

## Layout

```
prisma/schema.prisma      46 tables; migrations include raw-SQL constraints
src/common/               envelope, filters, guards, decorators, utils
src/config/               one namespace per concern + env validation
src/database/             Prisma service and error translation
src/redis/                connections, locks, counters
src/modules/              business domains (auth, deliveries, wallets, …)
src/gateway/              Socket.IO gateways
src/jobs/                 BullMQ processors
```

## Architecture

The data model, endpoint contracts, delivery state machine, matching pipeline,
wallet ledger and the security model are documented in the
[architecture blueprint](https://claude.ai/code/artifact/46cdeb14-2c91-4874-bf97-c65e1cccc124).
