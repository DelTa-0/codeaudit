# Admin console — design

**Date:** 2026-08-19
**Status:** approved for implementation

## Problem

CodeAudit has no operator view. Every role in the system is *org-scoped*
(`org_members.role` is `owner | admin | developer`), so there is no way to ask
platform-wide questions — how many people are using this right now, what is the
queue doing, what failed in the last hour, which account is generating the load.
Answering any of them today means opening a psql session against production.

Two things are missing, and they are different:

1. **A platform role.** An org "admin" is an admin *of their own workspace*. That
   must never grant sight of anyone else's data. The operator role is a separate
   axis.
2. **Observability worth looking at.** `audit_log` exists but is org-scoped, thin
   (five columns), and written by only a handful of routes. Nothing records
   worker activity, queue health, or failures at all.

## Non-goals

- Impersonation ("log in as this user"). High blast radius, and nothing in the
  current support load needs it.
- Editing another org's repos, scans, or findings from the panel. The console is
  for *operating* the platform, not for reaching into customer data.
- A log-shipping pipeline. Postgres holds these volumes comfortably at current
  scale; when it stops being true, the `system_events` shape ports to anything.

## The security model

### Platform role lives on the user, not in the token

`users.platform_role` is `'user'` (default) or `'admin'`. It is deliberately
**not** a JWT claim. Tokens live seven days, so a claim-based role would mean
revoking an admin has no effect until their token expires — the exact window you
care about when you are revoking it. The guard re-reads the column from the
database on every admin request. That is one primary-key lookup on a route group
that handles a few requests a minute.

### Deny by default, at the router

`requirePlatformAdmin` is mounted on the `/api/admin` router itself, not
route-by-route, so a new endpoint added to that file is protected by
construction rather than by the author remembering.

### Non-admins get 404, not 403

`/api/admin/*` answers a non-admin with the same "Not found" every unrouted path
returns. A 403 confirms the namespace exists and that the caller merely lacks a
role, which is a free hint to anyone probing. The panel should not be
discoverable from the outside.

### Step-up confirmation for privilege changes

Granting or revoking platform admin, and suspending an account, require the
caller's **own password** in the request body. A stolen or borrowed JWT is then
not enough to mint a second admin. Two self-protections close the obvious
footguns: an admin cannot revoke their own role, and cannot suspend themselves.

### The log is append-only from the panel

There is no delete or edit endpoint for `audit_log` or `system_events`. An
operator who can quietly erase their own trail has no trail. Rows leave only by
the age-based retention sweep, which is time-based and indiscriminate.

### Data minimisation

The admin serialisers are allow-lists, never `SELECT *`. Password hashes, CLI
tokens, badge tokens, GitHub installation tokens, webhook secrets, and Stripe
identifiers are not exposed by any admin endpoint. The panel answers "who and
how much", not "what is in their code".

### Its own rate limit

`/api/admin` gets a dedicated bucket. The endpoints are aggregate queries and
are more expensive than the rest of the API; a runaway dashboard poll should not
be able to sit on the connection pool.

## Presence: what "currently using the system" means

`users.last_seen_at`, touched by middleware on authenticated requests, throttled
to at most one write every two minutes per user. That yields:

- **Online now** — `last_seen_at > now() - 5 minutes`
- **Active today / 7d / 30d** — the usual rollups off the same column

The same middleware pass also reads `suspended_at`, so suspension takes effect on
the suspended user's *next request* rather than at their next login. One
indexed read, one conditional write, on a request path that already runs several
queries.

## Logging: two tables, deliberately

### `audit_log` — what a person did

Extended with `ip`, `user_agent`, `method`, `path`, `status`, and `duration_ms`,
and `org_id` becomes properly optional (platform-level actions have no org).
Written automatically by middleware for **every mutating request** (POST, PATCH,
PUT, DELETE) plus authentication events — login success, login failure,
registration — which are the ones you want during an incident and which no
mutation middleware would catch.

Reads are not logged. They are 90% of traffic, they would bury the signal, and
"who looked at what" is a different product with different retention rules.

### `system_events` — what the software did

Structured application events: `level` (`debug | info | warn | error`), `source`
(`api | worker | queue | webhook | billing | llm`), `event` (a stable dotted key
like `scan.failed`), `message`, and a `context` JSONB. The worker and queue
processors emit these; today those failures reach `console.error` and land
nowhere durable.

The split matters because the two answer different questions and have different
audiences. Merging them produces a table where every query needs a discriminator
and neither view is good.

### Retention

A sweep in the worker deletes `audit_log` older than 180 days and
`system_events` older than 30 days (both env-tunable). Unbounded log tables are
a slow-motion outage.

## Process tracking: read live, store nothing

Queue state is already authoritative in BullMQ and Postgres. The panel reads:

- **Queue depth** per queue (`scan`, `pr-comment`, `autofix`) — waiting, active,
  delayed, completed, failed — straight from BullMQ counters.
- **In-flight scans** — `scan_jobs` rows not yet terminal, with their `progress`
  string, age, and owning org.
- **Failed jobs** — recent failures with their reason, and a retry action.
- **Worker liveness** — the worker writes a heartbeat key to Redis every 15s;
  the panel reports it stale if older than 60s. This is the difference between
  "the queue is backed up" and "nothing is consuming the queue", which look
  identical from the queue depth alone.

Nothing here needs a new table, and a stored copy would only be able to be wrong.

## API surface

All under `/api/admin`, all behind the guard.

| Endpoint | Purpose |
| --- | --- |
| `GET /overview` | Stat tiles + 14-day signup/scan/error series |
| `GET /users` | Paginated, searchable, sortable user list |
| `GET /users/:id` | One user: orgs, repos, scan volume, recent activity |
| `PATCH /users/:id/role` | Grant/revoke platform admin (password step-up) |
| `PATCH /users/:id/suspension` | Suspend/reinstate (password step-up) |
| `GET /orgs` | Paginated org list with member/repo/scan counts |
| `GET /activity` | Filtered audit log (actor, action, org, status, range) |
| `GET /activity.csv` | Same filters, CSV export |
| `GET /events` | Filtered system events (level, source, event, range) |
| `GET /processes` | Queue counts, in-flight scans, failed jobs, worker heartbeat |
| `POST /processes/jobs/:queue/:jobId/retry` | Requeue one failed job |
| `GET /health` | Postgres, Redis, migrations, integrations, uptime, version |

Pagination is cursorless `limit`/`offset` with a hard `limit` ceiling of 200,
because these tables are small enough that offset paging is honest and the UI
wants a total count anyway.

## UI

Its own route tree at `/admin`, with its own layout — a left sidebar and a
distinctly darker chrome, so it is never ambiguous whether you are looking at
your own workspace or at everyone's. It reuses the existing design tokens
(`--color-ink`, `--color-primary`, the surface ramp); no new palette.

- **Overview** — live tiles (online now, active today, total users/orgs/repos,
  scans today, queue depth, error rate) over 14-day sparklines, plus the most
  recent errors.
- **Users** — search, sort, paginate; role and status badges; a detail panel with
  that account's orgs, volume, and activity, and the two privileged actions.
- **Organizations** — plan, members, repos, scans, last activity.
- **Activity** — the audit log with every filter in the URL, so a view is
  linkable, plus CSV export.
- **System events** — level-coloured stream with an auto-refresh toggle.
- **Processes** — queue cards, running scans with progress, failed jobs with
  retry, worker heartbeat.
- **Health** — dependency checks, green or red, with the failing detail.

`RequireAdmin` gates the route tree client-side; that is a UX affordance, not the
security boundary. The server refuses regardless.

## Seeding the admin

`server/src/db/seedAdmin.ts`, run via `npm run seed:admin`, reads `ADMIN_EMAIL`
and `ADMIN_PASSWORD` from the environment — never argv, which leaks into shell
history and `ps`. It is idempotent: an existing account is promoted, a new one is
created with a personal workspace. It refuses passwords under 12 characters and
prints no secret. The credentials are supplied by the operator at run time; none
are committed.

## Testing

`server/test/admin-access.ts` — the security assertions as executable checks:
a plain user gets 404 from every admin route, an org `owner` gets 404 (the two
role axes really are independent), an admin gets 200, a role change without the
password step-up is refused, self-revocation is refused, and the responses carry
no `password_hash` / `cli_token` / `badge_token` key at any depth.
