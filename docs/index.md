---
type: index
title: CodeAudit — Vault Home
created: 2026-07-17
updated: 2026-08-17
tags:
  - project/codeaudit
status: developing
---

# CodeAudit

AI Technical Debt Intelligence SaaS. Scans public and private GitHub repos
(JS/TS **and** Python) for hallucinated and unused dependencies, known
vulnerabilities, hardcoded secrets, zombie code — and, increasingly, for the
security of the AI agent configuration itself: prompt injection in
`CLAUDE.md`, unsafe MCP servers, and MCP servers redefined after approval.

Built from a "master build prompt" originally scoped as a 3–4 week PERN MVP,
then expanded mid-plan into a full multi-tenant SaaS (orgs/roles, GitHub App,
Stripe billing) at the user's request.

> [!info] What this actually is right now
> All 5 planned milestones are code-complete, and the product is **deployed
> and serving traffic** at `codeaudit.madhavaryal.info.np` (single EC2 host,
> docker compose). `codeorion` and `codeorion-mcp` are published on npm.
> GitHub OAuth login is fixed. Billing remains wired but untested against real
> Stripe test-mode webhooks.
>
> Since M5 the product has grown a second pillar — **AI agent security** —
> plus debt-over-time tracking (finding lifecycle, dependency attribution) and
> a rewritten three-axis score. See [[features/m6-ai-risk]].

## Map of content

- [[about]] — **start here**: single-page overview of the whole project (what it
  does, why, how it's built, and what's actually finished). Written to be handed
  to someone seeing the project for the first time
- [[architecture]] — stack, service layout, scan pipeline, deployment topology
- [[database-schema]] — all tables, relationships, migration history
- [[decisions]] — why things are built the way they are (ADR-style log)
- [[known-issues]] — current bugs, gaps, and things still needing real credentials
- [[roadmap]] — the 5-milestone plan and what's next (M5+ backlog)
- [[setup]] — how to run this locally
- [[api-keys-and-cli]] — every key/token across CLI, MCP, and dashboard, plus full usage instructions for all three

### Features by milestone
- [[features/m1-foundation]] — monorepo, docker-compose, migrations, JWT auth, orgs/roles, React shell
- [[features/m2-scan-engine]] — BullMQ worker, sandboxed clone, AST analysis, npm registry verdicts
- [[features/m3-llm-zombie-layer]] — dead-code candidate finder, LLM batch review, health score
- [[features/m4-github-app]] — OAuth login, App installation, webhooks, PR sticky comments
- [[features/m5-billing]] — Stripe checkout/portal/webhooks, plan-limit enforcement
- [[features/m6-ai-risk]] — scoring v2, finding lifecycle, dependency attribution, agent attack surface, MCP redefinition

## Quick facts

| | |
|---|---|
| Frontend | React 19, Vite 6, TypeScript, Tailwind v4, react-router-dom, recharts |
| Backend | Express 4, TypeScript (`tsx`), BullMQ (Redis), `pg` (no ORM, plain SQL migrations) |
| AI | Groq (`api.groq.com`, OpenAI-compatible), model `llama-3.3-70b-versatile` with `openai/gpt-oss-120b` as a fallback (token budgets are metered per model, so a fallback is a second budget) — despite `XAI_*` env var naming (legacy from an original xAI-Grok assumption; same naming trap as trackMyFinance, see [[known-issues]]) |
| Auth | JWT (email/password) + GitHub OAuth (account linking by email) |
| Multi-tenancy | Organizations with owner/admin/developer roles; every query is org-scoped |
| Infra | Docker Compose: Postgres 16 + Redis 7. API, worker, and web run natively via `npm run dev` |
| Repo | `C:\Users\ASUS\Desktop\vibe\codeaudit` — `https://github.com/DelTa-0/codeaudit` (**public** — it doubles as the Claude Code plugin marketplace) |
| Docs | This vault, `docs/` |

## Status

**Production:** live at `codeaudit.madhavaryal.info.np` on a single EC2 host
(API, worker, Postgres, Redis and Caddy under docker compose). Health green.

**Published:** `codeorion` (CLI) and `codeorion-mcp` (MCP server) on npm; the
`codeorion-guardrails` plugin via this repo's own Claude Code marketplace.

**Local dev:** API :4000, web :5173, Postgres :5433, Redis :6380.

#todo Migration `006_finding_lifecycle.sql` must be applied in production
before finding lifecycle and debt deltas do anything. The worker degrades
quietly without it — reconciliation is best-effort, so scans still succeed and
simply carry no delta.
