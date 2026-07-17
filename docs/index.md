---
type: index
title: CodeAudit — Vault Home
created: 2026-07-17
updated: 2026-07-17
tags:
  - project/codeaudit
status: developing
---

# CodeAudit

AI Technical Debt Intelligence SaaS. Scans public and private GitHub repos for
phantom/hallucinated npm dependencies, unused dependencies, and zombie code
(dead exports/functions/components judged by an LLM with confidence scores).
Built from a "master build prompt" originally scoped as a 3–4 week PERN MVP,
then expanded mid-plan into a full multi-tenant SaaS (orgs/roles, GitHub App,
Stripe billing) at the user's request.

> [!info] What this actually is right now
> All 5 planned milestones are code-complete and verified end-to-end
> (ground-truth fixture test, live scan against a real repo, signed webhook
> tests). GitHub OAuth login is mid-debug — see [[known-issues]]. Nothing has
> been pushed to Stripe live mode; billing is wired but untested against real
> Stripe test-mode webhooks (only a hand-signed fake payload).

## Map of content

- [[architecture]] — stack, service layout, scan pipeline, deployment topology
- [[database-schema]] — all tables, relationships, migration history
- [[decisions]] — why things are built the way they are (ADR-style log)
- [[known-issues]] — current bugs, gaps, and things still needing real credentials
- [[roadmap]] — the 5-milestone plan and what's next (M5+ backlog)
- [[setup]] — how to run this locally

### Features by milestone
- [[features/m1-foundation]] — monorepo, docker-compose, migrations, JWT auth, orgs/roles, React shell
- [[features/m2-scan-engine]] — BullMQ worker, sandboxed clone, AST analysis, npm registry verdicts
- [[features/m3-llm-zombie-layer]] — dead-code candidate finder, LLM batch review, health score
- [[features/m4-github-app]] — OAuth login, App installation, webhooks, PR sticky comments
- [[features/m5-billing]] — Stripe checkout/portal/webhooks, plan-limit enforcement

## Quick facts

| | |
|---|---|
| Frontend | React 19, Vite 6, TypeScript, Tailwind v4, react-router-dom, recharts |
| Backend | Express 4, TypeScript (`tsx`), BullMQ (Redis), `pg` (no ORM, plain SQL migrations) |
| AI | Groq (`api.groq.com`, OpenAI-compatible), model `llama-3.3-70b-versatile` — despite `XAI_*` env var naming (legacy from an original xAI-Grok assumption; same naming trap as trackMyFinance, see [[known-issues]]) |
| Auth | JWT (email/password) + GitHub OAuth (account linking by email) |
| Multi-tenancy | Organizations with owner/admin/developer roles; every query is org-scoped |
| Infra | Docker Compose: Postgres 16 + Redis 7. API, worker, and web run natively via `npm run dev` |
| Repo | `C:\Users\ASUS\Desktop\vibe\codeaudit` — pushed to `https://github.com/DelTa-0/codeaudit` (private) |
| Docs | This vault, `docs/` |

## Status

Live services (as of last session): API on :4000, web on :5173, worker running in background, Postgres on :5433, Redis on :6380 — all healthy.

#todo GitHub OAuth login is failing on `/user/emails` with a 403 — the App's "Email addresses" account permission needs to be granted *and* the user's existing authorization revoked/re-granted for it to take effect. See [[known-issues#GitHub OAuth email permission]].
