# Back office

The operator-facing half of the API, under `/api/v1/admin`. It shares one
database and one domain with the mobile apps: an operator cancelling a delivery
drives the same state machine a customer does, and a manual wallet credit
writes the same ledger a completed delivery writes. There is no second
implementation of anything, and no path that bypasses the rules.

## Getting in

There is no self-registration. The first operator comes from the seed:

```bash
ADMIN_BOOTSTRAP_PHONE=012000001 ADMIN_BOOTSTRAP_PASSWORD='...' npm run db:seed
```

It is created only when no back-office account exists at all, and only from
those variables — a deployment without them has no default credentials to
guess. Every operator after that is created by another operator through
`POST /admin/administrators`.

Signing in is the ordinary `POST /auth/login` with `role: ADMIN`. One phone
number may hold a customer account, a driver account and a back-office account
independently; they are separate users and suspending one does not touch the
others.

## Permissions

A **permission** is a code like `deliveries.cancel`. The catalogue lives in
`src/modules/admin/permissions.catalogue.ts` and is the single source of truth:
the seed installs it, roles are built from it, and an endpoint may only require
a code that appears in it. A **role** is a bundle of permissions; an operator
holds one role. A **super admin** passes every check regardless of role.

Two rules keep the catalogue honest, both enforced by
`test/admin-permission-matrix.e2e-spec.ts`:

- every `/admin` endpoint declares a permission, and
- every permission in the catalogue is required by at least one endpoint.

The second is the one that matters in practice — a permission nothing checks is
a checkbox in the role editor that grants nothing, which reads as a feature that
exists.

Permissions are resolved from the database on every request and cached for 60
seconds in Redis, and the cache is dropped the moment a role changes. A
permission revoked while an operator holds a live token is gone on their next
request. The access token also carries a copy for the dashboard's convenience;
the server never trusts it.

A refusal says what was missing:

```json
{ "success": false, "code": "FORBIDDEN",
  "message": "You do not have permission to cancel deliveries." }
```

### System roles

`Operations`, `Finance` and `Support` are seeded from the catalogue and are
read-only. The seed rewrites their permissions on every deploy, so an edit would
silently disappear; the API refuses one instead and asks you to build your own
role.

## What each area does, and what it deliberately refuses

**Dashboard** — one call for the whole home screen. Revenue is reported per
currency in minor units and never summed across currencies, because the platform
runs KHR and USD side by side. Days are calendar days in `APP_TIMEZONE`, not the
server's clock.

**Deliveries** — the list carries the platform split (commission, driver
earning) that the customer's own view hides, and the detail carries the dispatch
trail: every driver the job was offered to and what they did with it. Support
can cancel at any point before completion, including after pickup — precisely
the case a customer cannot handle in the app. Reassign returns a job to the
matching pool and is refused once the package has been collected.

**Drivers** — approval is refused while any required document is unreviewed,
naming the ones outstanding. Suspension is refused while the driver is holding a
delivery: the package is physically with them, so an operator reassigns or
cancels first. When a suspension does go through it takes effect in all three
places at once — out of the matching pool, every session revoked, cached
principal invalidated.

**Customers** — read-mostly on purpose. An operator can see an account and stop
it, but cannot edit someone's profile or addresses on their behalf. Suspension
leaves deliveries already in motion to finish; the driver is owed for them.

**Finance** — `approve` decides and moves nothing; `settle` records that the
bank actually paid and is the only call that debits a wallet. Settling requires
the provider's reference. Reviewing and settling are separate permissions, so
the person who approves a payout need not be the person who can move money. The
full bank account number is revealed by exactly one endpoint, behind the settle
permission, and every read of it is audited. Manual adjustments go through the
ledger with a reason on the driver's own statement; the balance is never written
directly.

**Pricing, zones and promos** — editing changes what the *next* booking costs
and nothing already priced. Every delivery stores the amount it was quoted, the
rule that produced it and a snapshot of the inputs, so a rule can be corrected
or retired without any historical figure moving. Nothing a delivery references
is hard-deleted. A promo's redemption count is not editable, and its usage limit
cannot be set below what has already been redeemed.

**Settings** — a catalogue of nine keys, each naming the environment variable it
overrides and each read by something real. A key not in the catalogue cannot be
written, and values are range-checked, so dispatch cannot be broken by a typo.
Changes take effect within seconds without a deploy; clearing an override falls
back to the deployment's own value.

**Notifications** — sending is queued, never done on the request thread: a
broadcast is thousands of writes and thousands of push attempts and must not
delay a driver's job offer. `POST /admin/notifications/audience-preview` says
how many people an audience covers before anything is written. A send already in
flight cannot be recalled, and the API says so rather than pretending.

**Roles and administrators** — the one area that can grant its own caller more
power, so it carries the rules that stop that: unrestricted access can only be
granted by someone who already has it and never on your own account, nobody can
change their own role or suspend themselves, and the last active super admin
cannot be demoted or suspended.

**Audit log** — every state-changing back-office action, with the values before
and after, the operator who acted and the address it came from. Written by the
platform; not editable from the API.

**Exports** — CSV, streamed by cursor so memory stays bounded, taking the same
filters as the screen they come from (pagination does not apply; an export
covers the whole filtered set). Money appears twice, as an exact decimal
and as the minor-unit integer, with the currency in its own column. Fields that
a spreadsheet would evaluate as a formula are prefixed with an apostrophe, which
is why phone numbers read as `'+855…` in the file — that is the mitigation
working, not a bug. Capped at 50,000
rows: past that the request is refused rather than silently truncated, because a
file that stops halfway and looks complete is how figures quietly go missing.
Every export is audited.

## Conventions

Everything the mobile API does, the back office does too: the `{success, code,
message, data, meta}` envelope, real HTTP status codes, cuid2 identifiers,
integer minor units with an explicit currency, offset pagination with
`page`/`limit`. The exception is the export endpoints, which return a CSV file.

## Tests

| File | Covers |
| --- | --- |
| `admin-permission-matrix.e2e-spec.ts` | Every route against the catalogue, in both directions; role gating; Swagger completeness |
| `admin-operations.e2e-spec.ts` | Dashboard and delivery administration |
| `admin-people.e2e-spec.ts` | Driver approval, documents, suspension, zones, customers |
| `admin-finance.e2e-spec.ts` | Payout review, settlement, wallet adjustments |
| `admin-configuration.e2e-spec.ts` | Pricing, zones, promos, settings |
| `admin-team.e2e-spec.ts` | Roles, administrators, escalation and lockout safeguards |
| `admin-notifications.e2e-spec.ts` | Audiences, campaign delivery, history |
| `admin-exports.e2e-spec.ts` | CSV correctness, injection handling, permissions |
