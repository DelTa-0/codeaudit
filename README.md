# CodeAudit

check for dev check okkkkkkkkk ok


AI Technical Debt Intelligence — a SaaS that audits GitHub repositories for:

1. **Phantom dependencies** — hallucinated packages that don't exist on npm
2. **Suspicious dependencies** — near-zero downloads or very recently published (typosquat heuristic)
3. **Unused dependencies** — declared in `package.json` but never imported
4. **Zombie code** — exported functions/components with zero call-sites, judged by an LLM (Grok) with confidence scores

**Stack:** PostgreSQL · Express · React · Node (PERN) + Redis/BullMQ job queue + Grok API.

## Quick start

```bash
docker compose up -d          # Postgres :5433, Redis :6380
cp .env.example .env          # then set JWT_SECRET (and XAI_API_KEY for LLM review)
cp .env server/.env
npm install
npm run migrate
npm run dev                   # api :4000, worker, web :5173
```

Open http://localhost:5173, register, connect a public GitHub repo, hit **Scan now**.

Without `XAI_API_KEY`, zombie-code candidates are still reported from static
analysis alone (confidence 0.5, marked "LLM review skipped").

## Architecture

```
React (5173) ──proxy──▶ Express API (4000) ──▶ BullMQ (Redis) ──▶ Worker
                              │                                     │ shallow clone → AST analysis
                              ▼                                     │ npm registry checks
                        PostgreSQL ◀────────────────────────────────┘ Grok LLM review
```

- The worker **never executes scanned code** — static analysis only (no `npm install` of targets).
- Clones are shallow, size/file-capped, per-job temp dirs deleted in `finally`.
- Repo URLs are validated server-side (HTTPS + github.com allow-list) — SSRF guard.
- All repo-derived content is treated as untrusted data in LLM prompts.
- Multi-tenant: organizations with owner/admin/developer roles; every query is org-scoped.

## Workspaces

- `server/` — Express API (`src/index.ts`) + BullMQ worker (`src/worker.ts`), SQL migrations in `migrations/`
- `web/` — React dashboard (Vite, Tailwind v4)

## GitHub App integration

Implemented: OAuth sign-in ("Continue with GitHub"), App installation linking,
private-repo cloning via installation tokens, HMAC-verified webhooks
(`POST /api/webhooks/github`) that auto-scan on push / pull_request, and a
sticky PR comment with the score delta and findings table.

To activate, register a GitHub App (permissions: contents read, pull requests
write; events: push, pull_request, installation) and set `GITHUB_APP_ID`,
`GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`,
`GITHUB_WEBHOOK_SECRET` in `.env`.

## Billing (Stripe, test mode)

Implemented: Checkout sessions, customer portal, signature-verified webhook
(`POST /api/webhooks/stripe`) driving plan upgrades/downgrades, and plan-limit
enforcement (repo counts, private repos, scans/day, webhook scans) returning
`402` when exceeded.

To activate, set `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_PRICE_PRO`, `STRIPE_PRICE_TEAM` (test-mode values).

## Testing

```bash
npm run test:ground-truth --workspace server
```

Runs the analysis engine against a seeded fixture with known ground truth
(phantom package, unused dep, two dead exports) — 7 assertions.

## Backlog

- Python/PyPI ecosystem, SSE live updates, Slack notifications
