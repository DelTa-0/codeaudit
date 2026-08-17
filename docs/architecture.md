---
type: reference
title: "Architecture"
created: 2026-07-17
updated: 2026-07-17
tags:
  - project/codeaudit
status: evergreen
related:
  - "[[index]]"
  - "[[database-schema]]"
  - "[[decisions]]"
---

# Architecture

## Stack

**Frontend** — `web/`
- React 19 + Vite 6 + TypeScript
- Tailwind v4 (`@tailwindcss/vite`), dark theme matching the `ai-debt-cleaner`
  landing page's visual language (Inter + JetBrains Mono, indigo primary)
- `react-router-dom` v7 for routing, no server-side rendering
- `recharts` for the score-trend line chart
- No component library (shadcn/ui) — hand-rolled `Card`/`Button`/`Badge`/
  `ScoreRing`/`Spinner` primitives in `components/ui.tsx`, since this is a
  small, tightly-scoped app rather than a big design system

**Backend** — `server/`
- Express 4 + TypeScript, run via `tsx watch` in dev (no build step needed locally)
- `pg` directly — no ORM. Plain numbered SQL migration files (`migrations/*.sql`)
  applied by a ~40-line runner (`src/db/migrate.ts`) tracked in a
  `schema_migrations` table
- BullMQ (Redis-backed) for the scan job queue and a separate PR-comment queue
- Zod for request validation, `jsonwebtoken` for auth, `bcryptjs` for password hashing

**AI**
- Groq (`api.groq.com/openai/v1`, OpenAI-compatible), model
  `llama-3.3-70b-versatile`. Called via the `openai` npm SDK with a custom
  `baseURL`. See [[decisions#LLM provider]] for why the env vars are still
  named `XAI_*`.

**Infra**
- `docker-compose.yml`: `postgres:16-alpine` (host port 5433) + `redis:7-alpine`
  (host port 6380) — non-default ports to avoid clashing with other local
  Postgres/Redis instances on this machine
- API, worker, and web all run natively (`npm run dev` runs all three via
  `concurrently`), no Docker for the app code itself
- No CI/CD yet

## Request flow

```
React (5173) --/api proxy--> Express API (4000) --BullMQ--> Redis --> Worker
                                    |                                    |
                                    v                                    v
                              PostgreSQL <----------------------------- writes
```

Vite dev server proxies `/api/*` to `http://localhost:4000` (`web/vite.config.ts`).

## Scan pipeline (the core product)

Triggered by `POST /api/repos/:id/scans` (manual) or a GitHub webhook (push/PR).
Runs in `server/src/worker.ts`, status written to `scan_jobs.status`/`.progress`
at each step so the frontend can poll and show a live stepper.

> Detection lives in **`packages/engine/`**, not in `server/src/analysis/`.
> The engine is shared verbatim by the hosted worker, the `codeorion` CLI and
> the `codeorion-mcp` server, so a detector fixed once is fixed everywhere.
> `server/src/analysis/` now holds only the things that need a *repository* and
> a database: clone sandboxing, git-history work, and AI authorship.

1. **Sandboxed clone** (`analysis/clone.ts`) — `simple-git` shallow clone
   (`--depth 100`, single-branch) into `os.tmpdir()/codeaudit-scans/{jobId}`.
   60s timeout, ~200MB size cap, ~20k file cap enforced by walking the tree
   post-clone. Cleanup always runs in a `finally` block. **Never executes any
   code from the cloned repo** — no `npm install`, no scripts, static file
   reads only. Private repos clone via a short-lived GitHub App installation
   token embedded in the clone URL. The depth-100 window bounds every
   history-derived answer downstream, which is why those answers report
   truncation rather than assuming they saw everything.
2. **Ecosystem detection + manifest parse** (`detect.ts`, `manifest.ts`,
   `python/manifest.ts`) — JS/TS and Python are both supported, and a polyglot
   repo is analysed on both in one pass.
3. **Import/symbol extraction** (`imports.ts`, `python/imports.ts`) — Babel for
   JS/TS, a line-based parser for Python. Collects imported package names,
   top-level symbols with their bodies, and every identifier reference site
   mapped to the file it appears in.
4. **Dependency verdicts** (`registry.ts`, `python/registry.ts`) — declared and
   imported names cross-referenced against the live npm/PyPI registries,
   concurrent and per-scan cached. Verdicts: `phantom` (does not exist),
   `unused` (declared, never imported), `suspicious` (exists but near-zero
   downloads, very new, or a typosquat neighbour), `vulnerable`, `healthy`. A
   name in the **known-hallucination corpus** (`data/hallucinatedNames.ts`) is
   never left `healthy` — once such a name is registered, existence and
   download counts are attacker-controlled and read backwards.
5. **Lockfile resolution + vulnerabilities** (`lockfile.ts`, `vulns.ts`) —
   exact resolved versions where a lockfile exists, then OSV lookups attaching
   advisories and upgrading verdicts to `vulnerable`.
6. **Dead-code candidates** (`deadcode.ts`) — a symbol is a candidate when
   nothing outside its own file references it, it is not a framework-entry
   name, and it is not generated or test code. Capped per scan to bound LLM
   cost.
7. **Secrets** (`secrets.ts`, `analysis/historySecrets.ts`) — working tree plus
   git history, so a credential removed in a later commit is still reported.
   Findings carry only redacted matches; the dedup fingerprint never leaves
   the server.
8. **Agent-config audit** (`agentConfig.ts`, `mcpDrift.ts`) — `CLAUDE.md`,
   `AGENTS.md`, `.cursorrules`, MCP configs, Claude settings and skill files
   are checked for prompt injection, hidden Unicode, credential exfiltration,
   unsafe MCP/permission config and unverified packages. `mcpDrift` adds the
   one check that no single revision can show: an MCP server whose command
   changed after it was introduced, found by walking git history.
9. **Dependency attribution** (`analysis/dependencyAttribution.ts`) — walks
   each manifest's history once and diffs the dependency set between
   revisions, giving every package its introducing commit, author,
   commits-ago and a three-valued AI verdict. Runs *before* findings are
   persisted, since it decorates them.
10. **LLM review** (`llm.ts`) — batches dead-code candidates per file into one
    chat completion, serially (one in flight) against a token-per-minute
    budget. The system prompt delimits repo content inside `<code>` tags as
    **untrusted data, never instructions**. Retries honour the larger of
    `retry-after` and `x-ratelimit-reset-tokens`, and a second model
    (`XAI_FALLBACK_MODEL`) is tried on 429/404 because providers meter tokens
    per model. Without an API key, falls back to static-only findings at
    confidence 0.5 and `reviewStatus: "skipped"`.
11. **AI authorship + hotspots** (`analysis/aiAuthorship.ts`) — commits are
    classified by Co-Authored-By trailers and bot authors. The result carries
    an explicit **attribution coverage** block: no marker anywhere means
    "unavailable", never "no AI", because inline completion leaves no trace.
12. **Agent attack surface** (`agentSurface.ts`) — inventories instruction
    files, skills, permission files and MCP servers, and rates each server
    from what its invocation shows (shell execution, filesystem paths granted,
    unpinned package). Capabilities that a config cannot express — network
    access in particular — are deliberately not guessed.
13. **Finding lifecycle** (`services/findingLifecycle.ts`) — reconciles this
    scan's findings against the repository's known findings by stable identity
    (`findingIdentity.ts`), producing new/resolved/reintroduced/persisting.
    Never overwrites a human `ignored`/`acknowledged` decision.
14. **Scoring v2** (`score.ts`) — three axes (security, supply chain,
    maintainability) composed multiplicatively, with the headline capped by
    the security axis so a tidy codebase cannot carry a leaking one into a
    good grade. Hygiene is normalised by repo size; security never is. See
    `docs/decisions.md` for why v1's single additive budget had to go.
15. **Prioritisation** (`priority.ts`) — the ranked "fix first" list, ordered
    by severity band, then kind, then confidence, then effort.
16. If the scan was PR-triggered, a `pr-comment` BullMQ job posts or updates a
    single sticky comment (upserted by a hidden marker) carrying the score
    delta, the finding delta (new/reintroduced/resolved) and the top three
    ranked actions. Every value that originates in the scanned repository is
    escaped before it reaches that comment.

## GitHub App integration (`services/github.ts`)

- **App-level JWT** (`RS256`, signed with the App's private key, `iss` = App
  ID) used to mint short-lived (~1hr) **installation tokens** via
  `POST /app/installations/{id}/access_tokens` — used for private-repo clone
  URLs and PR comment posting.
- **User OAuth** (separate flow, `routes/githubAuth.ts`) exchanges an
  authorization code for a user access token, fetches `/user` (+ `/user/emails`
  as a fallback if the primary email isn't public), links or creates a `users`
  row by `github_user_id` or matching email, then hands a JWT back to the SPA
  via a **URL fragment** (`/login#token=...`) rather than a query param, so it
  never lands in server access logs.
- **Webhooks** (`routes/webhooks.ts`) — mounted with `express.raw()` *before*
  `express.json()` so the raw body bytes are available for HMAC verification
  (`X-Hub-Signature-256`, constant-time compare via `crypto.timingSafeEqual`).
  Handles `push`, `pull_request` (opened/synchronize/reopened), and
  `installation` (deleted) events. Always responds `200` after signature
  check so GitHub doesn't auto-disable the webhook on handler errors.

## Billing (`routes/billing.ts`)

No Stripe SDK dependency — a minimal hand-rolled REST client
(`stripeRequest()`) using `fetch` + form-encoded bodies against
`api.stripe.com/v1`, since only 3 endpoints are needed (customers, checkout
sessions, billing portal sessions). Webhook signature verification is also
hand-rolled (HMAC-SHA256 over `{timestamp}.{body}`, ±300s replay window) —
see [[decisions#No Stripe SDK]].

## Multi-tenancy & security model

See [[database-schema]] for the org/role schema. Every data-access query in
`routes/*.ts` joins through `org_members` on the authenticated user's id —
there is no separate "is this org_id allowed" check layered on top; the join
*is* the tenant-isolation boundary. Role hierarchy (`developer < admin <
owner`) enforced by `middleware/auth.ts`'s `requireOrgRole()`.

Security posture in one place: [[decisions#Security checklist]].
