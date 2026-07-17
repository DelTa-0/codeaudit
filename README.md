# CodeAudit

AI Technical Debt Intelligence — a SaaS that audits GitHub repositories for:

1. **Phantom dependencies** — hallucinated packages that don't exist on npm
2. **Suspicious dependencies** — near-zero downloads or very recently published (typosquat heuristic)
3. **Unused dependencies** — declared in `package.json` but never imported
4. **Zombie code** — exported functions/components with zero call-sites, judged by an LLM with confidence scores

**Stack:** PostgreSQL · Express · React · Node (PERN) + Redis/BullMQ job queue + an OpenAI-compatible LLM (Groq by default).

Every automated action (auto-scan on push, merge gate, auto-fix PRs) is **opt-in per repository, off by default, and audit-logged** — nothing acts on your code without an explicit toggle and, where it matters, an explicit click.

---

## Table of contents

- [Quick start](#quick-start)
- [Configuration reference](#configuration-reference)
- [Architecture](#architecture)
- [Workspaces](#workspaces)
- [Feature guide](#feature-guide)
  - [Manual & webhook scans](#manual--webhook-scans)
  - [GitHub App integration](#github-app-integration)
  - [Merge gate](#merge-gate)
  - [Auto-fix PRs](#auto-fix-prs)
  - [README badge](#readme-badge)
  - [AI-authorship metrics](#ai-authorship-metrics)
  - [CLI (`npx codeaudit`)](#cli-npx-codeaudit)
  - [CLI/CI upload tracking](#clici-upload-tracking)
  - [Billing (Stripe test mode)](#billing-stripe-test-mode)
- [Testing](#testing)
- [Local ports](#local-ports)
- [Security posture](#security-posture)
- [Backlog](#backlog)

---

## Quick start

Prerequisites: Node.js 20+, Docker Desktop.

```bash
git clone https://github.com/DelTa-0/codeaudit
cd codeaudit

docker compose up -d          # Postgres :5433, Redis :6380

cp .env.example .env          # fill in JWT_SECRET at minimum
cp .env server/.env           # server/ loads its own .env via dotenv/config

npm install                   # installs all workspaces (server, web, cli, packages/engine)
npm run migrate               # applies server/migrations/*.sql in order

npm run dev                   # runs api (:4000) + worker + web (:5173) together
```

Open **http://localhost:5173**, register an account (this auto-creates a
personal organization with you as `owner`), paste a public GitHub repo URL,
click **Scan now**.

Everything above works with **zero optional config** — LLM review, GitHub
App features, and billing all degrade gracefully when unconfigured (see
below), so you can try the core product immediately.

### Individual dev commands

```bash
npm run dev:api        # Express API only
npm run dev:worker      # BullMQ scan worker only
npm run dev:web          # Vite dev server only (proxies /api to :4000)
npm run migrate           # apply pending SQL migrations
npm run build              # typecheck + build engine, server, web
npm run build:engine        # build just @codeaudit/engine
npm run build:cli            # build the engine + the codeaudit CLI
```

---

## Configuration reference

All server config lives in `server/.env` (gitignored — never commit real
secrets; `.env.example` at the repo root is the template).

### Core (required)

| Var | Default | Notes |
|---|---|---|
| `PORT` | `4000` | API port |
| `APP_URL` | `http://localhost:5173` | frontend origin, used for CORS + redirect URLs |
| `API_URL` | `http://localhost:4000` | used when building absolute URLs (badges, OAuth callback) |
| `DATABASE_URL` | `postgres://codeaudit:codeaudit@localhost:5433/codeaudit` | matches `docker-compose.yml` |
| `REDIS_URL` | `redis://localhost:6380` | matches `docker-compose.yml` |
| `JWT_SECRET` | — | **required**, any random string (`openssl rand -hex 32`) |

### LLM — zombie-code review (optional)

| Var | Notes |
|---|---|
| `XAI_API_KEY` | leave empty to skip LLM review entirely — dead-code candidates are still reported from static analysis alone, at fixed confidence 0.5, with reasoning `"LLM review skipped (no API key configured)"` |
| `XAI_BASE_URL` | OpenAI-compatible base URL. Default assumes **Groq** (`https://api.groq.com/openai/v1`), not xAI, despite the `XAI_*` naming (legacy from early planning — see [`docs/decisions.md`](docs/decisions.md#llm-provider)) |
| `XAI_MODEL` | e.g. `llama-3.3-70b-versatile` on Groq. Any OpenAI-compatible chat-completions model works if you point `XAI_BASE_URL` elsewhere (including real xAI's `api.x.ai/v1`) |

Get a free Groq key at [console.groq.com](https://console.groq.com).

### GitHub App (optional — unlocks OAuth login, private repos, webhooks, merge gate, auto-fix PRs)

| Var | Notes |
|---|---|
| `GITHUB_APP_ID` | numeric App ID, top of the App's settings page |
| `GITHUB_APP_PRIVATE_KEY_PATH` | absolute path to the downloaded `.pem` **file** (not its folder — this is a common mistake) |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | from the same App settings page, used for "Continue with GitHub" |
| `GITHUB_WEBHOOK_SECRET` | **you generate this yourself** (e.g. `openssl rand -hex 32`) and enter the identical value on both sides — GitHub doesn't hand it to you |

Without these set, GitHub-dependent endpoints return `501 Not configured`
rather than erroring; everything else in the app is unaffected.

**Setting up the App** — full walkthrough:

1. Create at [github.com/settings/apps/new](https://github.com/settings/apps/new) (a **GitHub App**, not an OAuth App)
2. **Callback URL**: `http://localhost:4000/api/auth/github/callback`
3. **Webhook URL**: GitHub cannot reach `localhost` — for local dev, run a tunnel (`ngrok http 4000`) and use its `https://*.ngrok-free.app/api/webhooks/github` URL. For production, use your deployed API's URL. The free-tier tunnel URL changes on every restart, so re-register it each time.
4. **Repository permissions**: Contents (Read & write — needed for [auto-fix PRs](#auto-fix-prs)), Pull requests (Read & write — PR comments), Checks (Read & write — [merge gate](#merge-gate))
5. **Account permissions**: Email addresses (Read-only) — required so OAuth login can fetch the user's email
6. **Subscribe to events**: Push, Pull request, Installation
7. Copy the **App ID** into `GITHUB_APP_ID`
8. **Private keys → Generate a private key** → downloads a `.pem` — move it somewhere outside the repo and point `GITHUB_APP_PRIVATE_KEY_PATH` at it
9. Copy **Client ID** / generate a **Client secret** into `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET`
10. **Install App** on the account/repos you want to test with

If you change permissions on an already-installed App, existing user
authorizations don't automatically pick up the new scope — revoke your
authorization at `github.com/settings/apps/authorizations` and sign in again
to force a fresh consent screen.

### Stripe (optional — test mode billing)

| Var | Notes |
|---|---|
| `STRIPE_SECRET_KEY` | test-mode secret key (`sk_test_...`) |
| `STRIPE_WEBHOOK_SECRET` | from the Stripe CLI or dashboard webhook endpoint config |
| `STRIPE_PRICE_PRO` / `STRIPE_PRICE_TEAM` | test-mode Price IDs for the two paid plans |

Without these set, `/billing/checkout` and `/billing/portal` return
`501 Not configured`.

> **Note:** as of this writing, plan-limit enforcement is **temporarily
> disabled for testing** — every org effectively has team-level limits
> regardless of its actual plan, so Stripe configuration isn't required to
> fully exercise the product today. See
> [`docs/decisions.md`](docs/decisions.md#plan-limit-gate-temporarily-disabled-for-testing)
> for how to re-enable enforcement (`server/src/services/plans.ts`).

---

## Architecture

```
React (5173) ──/api proxy──▶ Express API (4000) ──▶ BullMQ (Redis) ──▶ Worker
                                    │                                    │  shallow clone → AST analysis
                                    ▼                                    │  npm registry checks
                              PostgreSQL ◀─────────────────────────────┘  LLM zombie review → score
```

- The worker **never executes scanned code** — static analysis only, no `npm install` of scan targets.
- Clones are shallow (depth 100, for commit-history attribution), size/file-capped, per-job temp dirs deleted in a `finally` block.
- Repo URLs are validated server-side (HTTPS + `github.com` allow-list) — SSRF guard.
- All repo-derived content is treated as untrusted data in LLM prompts (prompt-injection guard).
- Multi-tenant: organizations with owner/admin/developer roles; every data query is org-scoped.
- Deeper design notes and decision rationale live in [`docs/`](docs/) (an Obsidian-compatible vault — see [`docs/index.md`](docs/index.md)).

---

## Workspaces

| Path | What it is |
|---|---|
| `packages/engine/` | `@codeaudit/engine` — the pure, environment-free analysis core (manifest parsing, AST import extraction, npm registry checks, dead-code detection, LLM review, scoring). Used by both the server and the CLI. |
| `server/` | Express API (`src/index.ts`) + BullMQ worker (`src/worker.ts`) + SQL migrations (`migrations/`) |
| `web/` | React dashboard (Vite, Tailwind v4) |
| `cli/` | `codeaudit` — the `npx`-runnable CLI, built on `@codeaudit/engine` |

---

## Feature guide

### Manual & webhook scans

Connect a repo by URL (dashboard → **Connect repo**) and click **Scan now**,
or enable the **Auto-scan on push & PR** toggle in a repo's settings card to
have GitHub trigger scans automatically. The scan pipeline:

1. Sandboxed shallow clone (never executes repo code)
2. `package.json` parse + AST import/symbol extraction (`@babel/parser`)
3. Dependency verdicts against the live npm registry (phantom / unused / suspicious / healthy)
4. Dead-code candidate detection (zero cross-file references)
5. LLM batch review of candidates (skipped gracefully without an API key)
6. AI-authorship attribution from commit history
7. Weighted health score (0–100, graded A–F)

Results stream to the dashboard via polling (~2s) with a live status stepper.

### GitHub App integration

"Continue with GitHub" login, GitHub App installation linking, private-repo
cloning via short-lived installation tokens, HMAC-verified webhooks
(`POST /api/webhooks/github`) driving auto-scan on push/PR, and a sticky PR
comment (score, delta, findings table) that updates in place on re-push
rather than spamming new comments. See
[Configuration reference](#github-app-optional--unlocks-oauth-login-private-repos-webhooks-merge-gate-auto-fix-prs)
for setup.

Repos connected either by pasting a URL or via the App's repo picker
auto-link an existing installation if one covers that repo — no manual
linking needed either way.

### Merge gate

Opt-in per repo (settings card → **Merge gate check**, off by default). When
enabled with a score threshold, every push/PR scan posts a GitHub **Check
Run** (`success`/`failure`, or `neutral` if the scan itself fails so a
CodeAudit outage never blocks anyone). **CodeAudit only reports the check —
whether it actually blocks a merge is entirely up to your own GitHub branch
protection rules.**

Requires the App's **Checks: read & write** permission.

### Auto-fix PRs

Two layers of explicit consent, by design:
1. The repo's **Auto-fix PRs** toggle must be turned on by an admin
2. Even then, nothing happens automatically — a human must click **Create
   fix PR** on a specific scan report

When triggered, opens a PR on a new `codeaudit/remove-unused-deps-*` branch
removing up to 10 confirmed-unused dependencies from `package.json`, with a
body naming who requested it. **It only ever proposes a PR — it never
commits to existing branches, never merges, never closes anything.** Only
one CodeAudit fix PR is kept open at a time per repo.

Requires the App's **Contents: read & write** permission.

### README badge

Settings card → **Get badge** generates an unguessable per-repo token and a
ready-to-paste markdown snippet:

```markdown
[![CodeAudit](http://localhost:4000/api/badge/<token>.svg)](http://localhost:5173)
```

The badge endpoint (`GET /api/badge/:token.svg`) is public (no auth — it has
to be, to render in a README), cached 5 minutes, colored by score band
(green ≥75, yellow ≥50, red below, grey if never scanned).

### AI-authorship metrics

Every scan attributes files to AI-assisted vs. human commits (heuristic:
`Co-Authored-By: Claude/Copilot/Cursor/...` trailers and known bot author
patterns in the last 100 commits) and reports:

- share of files that are majority AI-touched
- findings-per-100-files density, split AI vs. human

Shown as a card on the scan report when the repo has commit history to
analyze. Advisory only — a heuristic, not a certainty.

### CLI (`npx codeaudit`)

A deliberately **limited, funnel-oriented** local scanner — static analysis
only (phantom/unused/suspicious dependencies + dead-code *candidates*), no
LLM review, no history, no PR integration. Those stay platform-only so the
CLI drives adoption of the SaaS rather than replacing it.

```bash
npx codeaudit scan [dir]              # human-readable output
npx codeaudit scan . --json           # machine-readable, for CI parsing
npx codeaudit scan . --min-score 80   # exit 1 if score is below 80
```

Exit codes: `0` clean, `1` phantom dependencies found or below
`--min-score`, `2` usage/runtime error.

### CLI/CI upload tracking

By default the CLI is fully local and leaves no trace in the dashboard. To
track CLI or CI-pipeline runs (useful for GitLab CI, Jenkins, or any system
without GitHub webhooks):

1. Settings card → **CLI / CI uploads** → **Get token** — generates a
   per-repo token (treat it like a password; keep it in CI secrets, not
   source control)
2. Run with `--upload`:

```bash
CODEAUDIT_TOKEN=ca_xxxxx npx codeaudit scan . --upload --api https://your-codeaudit-api.example
```

On success the CLI prints the resulting dashboard URL. The upload lands in
the same scan history/trend chart as any other scan, tagged `trigger: cli`.
Uploads only ever happen with the explicit `--upload` flag.

### Billing (Stripe test mode)

Checkout sessions, customer billing portal, and a signature-verified webhook
(`POST /api/webhooks/stripe`) driving plan lifecycle
(`checkout.session.completed` → activate, `customer.subscription.updated` →
track `past_due`, `customer.subscription.deleted` → revert to free). No
Stripe SDK dependency — a small hand-rolled REST client is sufficient for
the three endpoints used. See [Configuration reference](#stripe-optional--test-mode-billing)
for setup, and the note there about plan-limit enforcement currently being
disabled.

---

## Testing

```bash
npm run test:ground-truth --workspace server
```

Runs the analysis engine directly against a seeded fixture
(`server/test/fixture/`) with known-correct answers — one fake package, one
unused real dependency, two dead exports, and two symbols that must *not* be
flagged (a cross-file-referenced helper and an entry-point-named function).
7 assertions, covering the core detection logic end-to-end without needing
the database or a live clone.

---

## Local ports

| Port | Service |
|---|---|
| 5173 | web (Vite dev server) |
| 4000 | API (Express) |
| 5433 | Postgres (host-mapped from the container's 5432, to avoid clashing with any default-port Postgres already on the machine) |
| 6380 | Redis (host-mapped from 6379, same reasoning) |

`.claude/launch.json` defines `codeaudit-web` (5173) and `codeaudit-api`
(4000) preview configs for agent tooling.

---

## Security posture

- Static analysis only — the worker never executes, `npm install`s, or evals scanned repo content
- Per-job sandboxed temp clone dirs with size (~200MB) / file-count (~20k) / time (60s) caps; cleanup always runs in a `finally` block
- Server-side repo URL validation (HTTPS + `github.com` allow-list) — SSRF guard for the manual-connect path
- GitHub and Stripe webhooks are both signature-verified with constant-time comparison before any payload is trusted
- Rate limiting on scan creation and CLI uploads
- Secrets live only in `server/.env` (gitignored) — never logged, never sent to the frontend
- Scanned repo content is explicitly delimited as **untrusted data** in LLM prompts — a stated prompt-injection guard
- Every org-scoped route enforces a minimum role (`developer < admin < owner`); tenant isolation is enforced by the join in every query, not a bolt-on check
- Every automated action (auto-scan, merge gate, auto-fix) is opt-in, off by default, and recorded in `audit_log`

---

## Backlog

Explicitly out of scope so far — not gaps in what was promised, just not
started yet:

- Python/PyPI ecosystem support
- Server-sent events for live scan status (currently ~2s polling)
- Slack/Discord notifications
- Real email transport for org invites (currently logged to the server console in dev)
- Deployment target / CI pipeline for the app itself

See [`docs/roadmap.md`](docs/roadmap.md) for the fuller, running list.
