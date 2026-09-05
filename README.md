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

## API documentation

Swagger UI is served at `/api/docs`, with the raw document at
`/api/docs/json`. It is generated from the running code, so it cannot drift
from the API.

Set `SWAGGER_USER` and `SWAGGER_PASSWORD` and the docs — page, assets and JSON
alike — sit behind HTTP Basic. Leave them blank in development to browse
freely; production refuses to start with the docs enabled and no credentials,
because the document maps every endpoint including the back office.

`npm run swagger:export` writes `openapi.json` without starting a server — for
generating a client, importing into Postman, or diffing the API surface in
review. The file is committed, so a change to the API shows up in the diff.

Operation ids read as method names (`customerDeliveries_create`), which is what
a generated client is named after. `test/openapi.e2e-spec.ts` holds the
document to its promises: every operation has a summary, a declared tag, a
documented response and — unless deliberately public — a bearer requirement,
and no tag is declared that nothing uses.

Docs are **off by default in production**, since the document describes every
endpoint including the back office. Set `SWAGGER_ENABLED=true` there only if
they are meant to be public.

## Running it

`Dockerfile` builds a production image: multi-stage, production dependencies
only, non-root, with `dumb-init` as PID 1 so `SIGTERM` reaches Node and Nest's
shutdown hooks actually run. `HEALTHCHECK` uses the same readiness probe the
platform exposes. No `.env` is ever copied in.

`.github/workflows/ci.yml` typechecks, lints, unit-tests and builds, then runs
the full e2e suite against real Postgres, Redis and MinIO services — uploads
and signed URLs are exercised for real, so a stub would not be honest — and
builds the image on every change so a broken Dockerfile is caught before a
deploy rather than during one.

## Production safety

`validateEnv` refuses to start in production with configuration that is only
safe on a laptop:

- `OTP_EXPOSE_IN_RESPONSE=true` — it returns verification codes in the API
  response, so anyone who can call register with someone else's number gets
  their code
- `CORS_ORIGINS=*` — the API sends credentials
- `SWAGGER_ENABLED=true` without `SWAGGER_USER`/`SWAGGER_PASSWORD`
- signing secrets that still look like placeholders, or one secret shared
  between access and refresh tokens

It refuses rather than warns, because a warning in a startup log is read once
and never again.

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
prisma/schema.prisma      54 tables; migrations include raw-SQL constraints
src/common/               envelope, filters, guards, decorators, utils
src/config/               one namespace per concern + env validation
src/database/             Prisma service and error translation
src/redis/                connections, locks, counters
src/modules/              business domains (auth, deliveries, wallets, …)
src/gateway/              Socket.IO gateways
src/jobs/                 BullMQ processors
docs/back-office.md       how the admin API is meant to be used
```

## What is built

Nine phases for the mobile apps, eight for the back office, then a
correctness pass. 179 endpoints, 3 socket messages, 587 tests.

| Area | Highlights |
| --- | --- |
| Auth | Registration → OTP → password, single-use refresh tokens with family revocation, Argon2id, per-account sign-in lockout, device-bound refresh |
| Profiles | Customer and driver profiles, addresses, vehicles, documents, MinIO storage with signed URLs |
| Delivery | Quote and booking on one pricing path, a state machine with per-actor rules, full audit trail |
| Matching | Redis GEO presence, widening rounds, one `/matrix` call per round, atomic accept |
| Execution | Arrive, collect, deliver, proof of delivery, completion; IN_TRANSIT set by the location stream |
| Realtime | One authenticated socket per app, server-verified rooms, live position and status |
| Money | Integer minor units, wallet ledger with before/after balances, reservations, ABA PayWay KHQR |
| Engagement | Ratings, favourite drivers, package templates, chat, notifications |
| Back office | Permissions and roles, dashboard, delivery support, driver approval, payout settlement, refunds, pricing, notifications, audit log, CSV exports |
| Correctness | Cash commission charged to the driver rather than given away, idempotent money endpoints, settlement reconciliation, atomic promo limits, arrival verification |
| Retention | Scheduled pruning of track points, spent credentials, push diagnostics and orphaned files — the tables and buckets that only ever grew |

The back office is documented separately in [docs/back-office.md](docs/back-office.md).

### Known gaps

Two integrations are wired but not connected, both waiting on credentials
rather than code:

- **Push** — notifications are stored and pushed over the socket, but FCM is not
  called. Swap the `PUSH_SENDER` provider in `notifications.module.ts`.

It does not pretend to succeed: a push attempt is recorded as `SKIPPED` rather
than `SENT`.

**SMS is live.** OTP codes go over PlasGate when `PLASGATE_PRIVATE_KEY`,
`PLASGATE_SECRET_KEY` and `PLASGATE_SENDER` are set, and fall back to the log
when they are not — so local development is unchanged. Escape every `$` in the
secret key as `\$`: env values pass through variable expansion, which silently
eats `$5$rounds=…` down to `$5=…`.

**Refunds** are recorded and settled by an operator against the provider's own
reference; the platform does not call a provider refund API. That is a
deliberate two-step rather than a gap, and it is the same discipline payouts
use — but it does mean someone issues the refund in the PayWay dashboard.

**COD goods money** — the cash a driver collects on a sender's behalf when
`codEnabled` is set — is recorded (`codAmount`, `codCollectedAt`) and reported,
but the platform does not model handing it back to the sender. The delivery
fee and its commission are fully accounted for; the goods money is not.

**ABA PayWay** is live against sandbox. The supplied merchant account is
sandbox-only and enabled for USD, so a KHR delivery is refused with an
actionable message. Production needs different credentials in `PAYWAY_*`.

## Architecture

The data model, endpoint contracts, delivery state machine, matching pipeline,
wallet ledger and the security model are documented in the
[architecture blueprint](https://claude.ai/code/artifact/46cdeb14-2c91-4874-bf97-c65e1cccc124).
