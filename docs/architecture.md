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

1. **Sandboxed clone** (`analysis/clone.ts`) — `simple-git` shallow clone
   (`--depth 1`) into `os.tmpdir()/codeaudit-scans/{jobId}`. 60s timeout,
   ~200MB size cap, ~20k file cap enforced by walking the tree post-clone.
   Cleanup always runs in a `finally` block. **Never executes any code from
   the cloned repo** — no `npm install`, no scripts, static file reads only.
   Private repos clone via a short-lived GitHub App installation token
   embedded in the clone URL (`x-access-token:{token}@github.com/...`).
2. **Manifest parse** (`analysis/manifest.ts`) — reads `package.json`
   `dependencies`/`devDependencies` as plain JSON text.
3. **Import/symbol extraction** (`analysis/imports.ts`) — walks
   `.js/.jsx/.ts/.tsx/.mjs/.cjs` files (skips `node_modules`, `dist`, `build`,
   files >1MB), parses each with `@babel/parser`
   (`typescript`+`jsx`+`decorators-legacy`+`classProperties` plugins,
   `errorRecovery: true` so one bad file doesn't kill the scan). Collects:
   - every imported/required npm package name (bare specifiers only)
   - every top-level/exported function, arrow-function-const, and
     PascalCase symbol (candidate "component"), with its line range and body text
   - every identifier + JSX-tag reference site, mapped to the file it appears in
4. **Dependency verdicts** (`analysis/registry.ts`) — cross-references
   declared + imported package names against the real npm registry
   (`registry.npmjs.org/{name}`, `api.npmjs.org/downloads/point/last-week/{name}`),
   5-way concurrent, in-memory cached per scan. Verdicts:
   - `phantom` — 404 on the registry (hallucinated/typosquat)
   - `unused` — declared in package.json, never imported
   - `suspicious` — exists but <50 weekly downloads or published <90 days ago
   - `healthy` — everything else
5. **Dead-code candidates** (`analysis/deadcode.ts`) — a symbol is a candidate
   when nothing *outside its own file* references it (using the reference map
   from step 3), it's not an ignored framework-entry name (`main`, `loader`,
   `getServerSideProps`, etc.), and it's not in a test/mock/script path. Capped
   at 40 candidates per scan to bound LLM cost.
6. **LLM review** (`analysis/llm.ts`) — batches candidates per file into one
   Groq chat completion (2-3 concurrent requests, `temperature: 0`, JSON-only
   response schema). System prompt explicitly delimits repo content inside
   `<code>` tags as **untrusted data, never instructions** — a prompt-injection
   guard against adversarial comments in scanned code. Retries on 429/5xx with
   exponential backoff; malformed/unparseable responses are dropped, never
   crash the scan. **Without `XAI_API_KEY` configured, falls back to
   static-only findings** at confidence 0.5.
7. **Scoring** (`analysis/score.ts`) — weighted: phantom −15/ea, suspicious
   −6/ea, unused −3/ea, zombies up to −20 total (confidence-weighted), clamped
   [0,100], graded A–F. Written to `scan_jobs.summary` (JSONB) and
   `repositories.latest_score`.
8. If the scan was PR-triggered (`pr_number` set), a `pr-comment` BullMQ job
   is enqueued (`queue/prComment.ts`) which posts/updates a single sticky PR
   comment (upserted by a hidden HTML-comment marker) with the score delta
   vs. the repo's last non-PR scan and a findings table.

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
