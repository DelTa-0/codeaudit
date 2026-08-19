---
type: reference
title: "M7 — Admin Console"
created: 2026-08-19
updated: 2026-08-19
tags:
  - project/codeaudit
status: evergreen
related:
  - "[[index]]"
  - "[[architecture]]"
  - "[[database-schema]]"
---

# M7 — Admin Console

The platform-operator view: who is using CodeAudit right now, what everyone did,
what the software did, and what the queues are doing. Lives at `/admin`, served
by `/api/admin/*`.

## The two role axes

`org_members.role` (`owner | admin | developer`) governs a *workspace*. It always
has, and nothing about being an org owner should reveal another tenant's data.

`users.platform_role` (`user | admin`) governs *the platform*. It is a separate
column on `users` precisely so the two can never be confused, and the access test
asserts that an org `owner` gets 404 from every admin route.

The platform role is **not** a JWT claim. Tokens live seven days, so a
claim-based role would keep a revoked operator privileged for up to a week — the
exact window that matters when you are revoking it. `requireAuth` re-reads the
column on every authenticated request, which also makes suspension effective on
the account's next request rather than at its next login.

## Security properties

| Property | How |
| --- | --- |
| Deny by default | The guard is mounted on the `/api/admin` router, not per route |
| Undiscoverable | Non-admins get **404**, not 403 — a 403 confirms the namespace exists |
| Fresh authorization | Role read from Postgres per request, never from the token |
| Step-up on privilege | Role changes and suspensions require the caller's own password |
| No self-lockout | An admin cannot revoke their own role or suspend themselves |
| No peer ambush | Suspending another admin requires revoking their role first |
| Append-only log | No endpoint deletes or edits log rows; only the retention sweep removes them |
| Data minimisation | Allow-listed columns — no password hashes, CLI/badge tokens, or Stripe ids |
| Own rate limit | 240 req/min, separate from the rest of the API |

All of these are asserted in `server/test/admin-access.ts`
(`npm run test:admin-access --workspace server`), against a running API.

## Presence

`users.last_seen_at`, touched by `requireAuth` at most once every two minutes per
user. "Online now" is a five-minute window; active-today/week/month are rollups
off the same column. No session store, no extra table.

## The two logs

**`audit_log` — what a person did.** Written automatically by
`middleware/activity.ts` for every mutating request (POST/PUT/PATCH/DELETE), plus
the authentication events (`auth.login`, `auth.login_failed`, `auth.registered`)
that no mutation-shaped middleware would catch. Routes that call `logAudit` get a
*semantic* entry (`repo.connected`) instead of the generic `POST /api/…` one —
one action, one row. Reads are deliberately not recorded.

The plumbing is `lib/requestContext.ts`: an `AsyncLocalStorage` that lets
`logAudit` enrich an entry with the request that caused it without threading a
`req` through its ~20 call sites, and defers the insert until the response
finishes so the row can carry the status and duration.

**`system_events` — what the software did.** `level` × `source` × a stable dotted
`event` key, plus a `context` JSONB. Emitted by the worker (scan failures, job
failures), the API (unhandled 500s), and privileged admin actions.

Retention runs in the worker four times a day: 180 days for `audit_log`, 30 for
`system_events`, both tunable via `AUDIT_LOG_RETENTION_DAYS` and
`SYSTEM_EVENT_RETENTION_DAYS`.

## Process tracking

Read live, never mirrored — a stored copy of queue state could only be wrong.

- Queue depth per queue, straight from BullMQ counters. A Redis outage surfaces
  as `unreachable`, never as a reassuring row of zeroes.
- In-flight scans from `scan_jobs`, oldest first, flagged past 15 minutes.
- Failed jobs with their reason and a retry action.
- **Worker heartbeat** — the worker writes a Redis key every 15s (TTL 45s); the
  panel reports it down past 60s. This is the only thing that separates "the
  queue is backed up" from "nothing is consuming the queue", which look identical
  from the depth alone.

## Seeding the operator account

```bash
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-passphrase' \
  npm run seed:admin --workspace server
```

Credentials come from the environment, never argv — argv lands in shell history
and is readable via `ps`. Idempotent: an existing account is promoted (password
untouched unless `ADMIN_RESET_PASSWORD=true`), a new one is created with a
personal workspace so the operator is also a usable normal user. Minimum
password length is 12, deliberately above the app's 8: this account can read
every log and grant its own role to others.

## Pages

| Route | What it answers |
| --- | --- |
| `/admin` | Who is online, totals, 14-day trend, queue state, recent problems |
| `/admin/users` | Every account; detail panel with workspaces, volume, history, and the two privileged actions |
| `/admin/orgs` | Every workspace with size and usage |
| `/admin/activity` | Filtered audit log, linkable via the URL, CSV export |
| `/admin/events` | System event stream with a live tail |
| `/admin/processes` | Queues, running scans, failed jobs, worker liveness |
| `/admin/health` | Postgres, Redis, worker, integrations, migrations, runtime |

Filters live in the URL so any view is linkable — "here is the activity view
showing the failures" is most of the value of having filters.
