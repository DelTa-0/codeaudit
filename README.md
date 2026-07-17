# CodeAudit

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

## Roadmap

- GitHub App: OAuth sign-in, private repos, auto-scan on push, PR sticky comments (M4)
- Stripe test-mode billing with plan limits (M5)
- Python/PyPI ecosystem, SSE live updates, Slack notifications (backlog)
