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
an org via `POST /api/orgs/:orgId/installations`. `account_login` and
`repository_selection` (`all|selected`) are recorded at link time and
refreshed on every re-link, so the dashboard can explain a missing repository
as "you only granted access to some" rather than leaving the absence
unexplained. An org may own **more than one** installation (a user account
and an org account, say) and the repo picker merges across all of them.

**`repositories`** — `full_name` (`owner/repo`), `private`, `webhook_enabled`,
`latest_score` (denormalized from the most recent completed scan, updated by
the worker). Unique on `(org_id, full_name)`. Per-repo opt-in settings added
later: `gate_enabled` + `min_score` (merge gate), `autofix_enabled`,
`badge_token` (README badge), `cli_token` (CLI/CI uploads). All default off —
nothing acts on a repository without an explicit toggle.

**`scan_jobs`** — the central work-tracking table. `trigger`
(`manual|push|pull_request`), `status`
(`pending|cloning|analyzing|complete|failed`), `progress` (human-readable
label shown in the UI stepper), `pr_number` (set only for PR-triggered scans,
drives the sticky-comment job), and `summary` (JSONB).

`summary` has grown well past "score, grade, counts" and is the main
extension point — new analysis lands here rather than in new columns:
`score`/`grade`/`scoreVersion`/`axes` (scoring v2), `counts`, `reviewStatus`,
`ai` (authorship stats + attribution coverage), `agentSurface` (agent
inventory and MCP risk), `findingDelta` (new/resolved/reintroduced since the
previous scan), `priorities` (the ranked fix-first list) and `advisories`.

**`dependency_findings`** — one row per package per scan. `status`
(`phantom|unused|healthy|suspicious|vulnerable`), `registry_metadata` (JSONB).
That JSONB carries far more than the raw registry response now: `created`,
`latest`, `weeklyDownloads`, `deprecated`, `vulnerabilities`/`maxSeverity`
(OSV), `typosquatOf`, `alternatives`, `hallucinated` (known-invented name
corpus) and `attribution` (introducing commit, author, commits-ago and the
three-valued AI verdict).

**`code_findings`** — one row per code-shaped finding per scan.
`finding_type` started as `dead_function|dead_export|dead_component` and is
unconstrained `TEXT` by design, so secrets and agent-config findings ride the
same table. `confidence_score` (numeric 0.00–1.00 from the LLM, or a fixed
0.5 fallback when no LLM key is configured), `llm_reasoning` (free text), and
`detail` (JSONB) for finding types that do not fit the original
dead-code-shaped columns — a redacted secret match, or an agent-config rule
and its sanitized evidence.

**`finding_lifecycle`** — one row per distinct *problem* per repository,
rather than per scan. This is what makes "first detected", "fixed",
"reintroduced" answerable at all. `finding_key` is the stable identity
computed in the engine (`packages/engine/src/findingIdentity.ts`) so the CLI
and the hosted worker agree on what counts as the same finding; `state` is
`open|fixed|ignored|acknowledged`. A scan may move a row between `open` and
`fixed` and record sightings, but **never** overwrites `ignored` or
`acknowledged` — those record a human decision, and a scan silently reopening
a dismissed finding would make dismissal worthless. Unique on
`(repo_id, finding_key)`.

**`audit_log`** — append-only, best-effort (a failed insert is logged and
swallowed, never breaks the request — see `services/audit.ts`). Records
org/repo/scan/member/billing lifecycle events.

## Relationships

```
users ──< org_members >── organizations ──< github_installations
                                        │
                                        ├──< repositories ──< scan_jobs ──< dependency_findings
                                        │         │                   └──< code_findings
                                        │         ├──< finding_lifecycle
                                        │         └── latest_score (denormalized)
                                        ├──< invites
                                        └──< audit_log
```

`finding_lifecycle` hangs off `repositories`, not `scan_jobs` — that is the
whole point of it. Per-scan findings die with their scan; a lifecycle row
outlives every scan that saw it, and only references them (`first_detected_scan`,
`last_seen_scan`, both `ON DELETE SET NULL` so pruning old scans loses the
pointer, not the history).

All child tables cascade-delete from `organizations` and their immediate
parent (e.g. deleting a `repositories` row cascades its `scan_jobs`, which
cascades `dependency_findings`/`code_findings`).

## Indexes

`org_members(user_id)`, `repositories(org_id)`, `scan_jobs(repo_id)`,
`scan_jobs(org_id)`, `dependency_findings(scan_job_id)`,
`code_findings(scan_job_id)`, `audit_log(org_id)` — all added in the same
migration, sized for the current query patterns (org-scoped lookups, repo →
scans, scan → findings).

`finding_lifecycle(repo_id, state)` and `finding_lifecycle(repo_id, kind)`
(migration 006) serve the two queries that table exists for: "what is open
for this repo" and "history for this kind of finding".

## Migration history

| File | What it did |
|---|---|
| `001_core.sql` | Initial schema, applied 2026-07-17 |
| `002_repo_settings.sql` | Per-repo opt-ins on `repositories`: `gate_enabled`, `min_score`, `autofix_enabled`, `badge_token` |
| `003_cli_token.sql` | `repositories.cli_token` — per-repo token for `codeorion scan --upload` |
| `004_finding_detail.sql` | `code_findings.detail` JSONB, so finding types that are not dead-code-shaped (secrets, agent config) can ride the same table |
| `005_installation_selection.sql` | `github_installations.repository_selection` — whether an installation was granted all repositories or a hand-picked list |
| `006_finding_lifecycle.sql` | `finding_lifecycle` — findings that outlive the scan that found them |
