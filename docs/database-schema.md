---
type: reference
title: "Database Schema"
created: 2026-07-17
updated: 2026-07-17
tags:
  - project/codeaudit
status: evergreen
related:
  - "[[index]]"
  - "[[architecture]]"
---

# Database Schema

One migration so far: `server/migrations/001_core.sql`. No ORM — tables and
relationships are the source of truth, queried directly with `pg`.

## Tables

**`users`** — `password_hash` nullable (GitHub-only accounts have no
password), `github_user_id` unique+nullable (links a GitHub identity).

**`organizations`** — the tenant boundary. `plan` (`free|pro|team`),
`plan_status` (`active|past_due|canceled`), `stripe_customer_id` /
`stripe_subscription_id`.

**`org_members`** — join table, `role` (`developer|admin|owner`), unique on
`(org_id, user_id)`. Every registration auto-creates a personal org with the
new user as `owner`.

**`invites`** — token-based, 7-day expiry, `accepted_at` marks completion.
Local dev has no real email transport — invite links are logged to console
(`[invite] email -> /invites/{token}`) rather than sent.

**`github_installations`** — one row per GitHub App installation, linked to
an org via `POST /api/orgs/:orgId/installations`.

**`repositories`** — `full_name` (`owner/repo`), `private`, `webhook_enabled`,
`latest_score` (denormalized from the most recent completed scan, updated by
the worker). Unique on `(org_id, full_name)`.

**`scan_jobs`** — the central work-tracking table. `trigger`
(`manual|push|pull_request`), `status`
(`pending|cloning|analyzing|complete|failed`), `progress` (human-readable
label shown in the UI stepper), `summary` (JSONB — score, grade, counts),
`pr_number` (set only for PR-triggered scans, drives the sticky-comment job).

**`dependency_findings`** — one row per package per scan. `status`
(`phantom|unused|healthy|suspicious`), `registry_metadata` (JSONB — raw npm
registry response fields: `created`, `latest`, `weeklyDownloads`).

**`code_findings`** — one row per zombie-code finding per scan.
`finding_type` (`dead_function|dead_export|dead_component`),
`confidence_score` (numeric 0.00–1.00 from the LLM, or a fixed 0.5 fallback
when no LLM key is configured), `llm_reasoning` (free text).

**`audit_log`** — append-only, best-effort (a failed insert is logged and
swallowed, never breaks the request — see `services/audit.ts`). Records
org/repo/scan/member/billing lifecycle events.

## Relationships

```
users ──< org_members >── organizations ──< github_installations
                                        │
                                        ├──< repositories ──< scan_jobs ──< dependency_findings
                                        │         │                   └──< code_findings
                                        │         └── latest_score (denormalized)
                                        ├──< invites
                                        └──< audit_log
```

All child tables cascade-delete from `organizations` and their immediate
parent (e.g. deleting a `repositories` row cascades its `scan_jobs`, which
cascades `dependency_findings`/`code_findings`).

## Indexes

`org_members(user_id)`, `repositories(org_id)`, `scan_jobs(repo_id)`,
`scan_jobs(org_id)`, `dependency_findings(scan_job_id)`,
`code_findings(scan_job_id)`, `audit_log(org_id)` — all added in the same
migration, sized for the current query patterns (org-scoped lookups, repo →
scans, scan → findings).

## Migration history

| File | What it did |
|---|---|
| `001_core.sql` | Everything above — initial schema, applied 2026-07-17 |
