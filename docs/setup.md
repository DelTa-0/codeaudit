---
type: reference
title: "Setup"
created: 2026-07-17
updated: 2026-07-17
tags:
  - project/codeaudit
status: evergreen
related:
  - "[[index]]"
  - "[[architecture]]"
---

# Setup

## Prerequisites

- Node.js (v24 used in dev)
- Docker Desktop (for Postgres + Redis)

## First-time setup

```bash
cd C:\Users\ASUS\Desktop\vibe\codeaudit
docker compose up -d          # Postgres :5433, Redis :6380
cp .env.example .env
cp .env server/.env           # server/ reads its own .env via dotenv/config
npm install                   # installs both workspaces (server + web)
npm run migrate               # applies server/migrations/*.sql
```

Then fill in `server/.env` (this file is gitignored, never committed):

| Var | Required for | Notes |
|---|---|---|
| `JWT_SECRET` | everything | any random string |
| `XAI_API_KEY` | LLM zombie-code review | actually a **Groq** key, see [[decisions#LLM provider]] — get one free at console.groq.com |
| `XAI_BASE_URL` | ^ | `https://api.groq.com/openai/v1` |
| `XAI_MODEL` | ^ | `llama-3.3-70b-versatile` (or check `GET /v1/models` for what your key can access) |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET` | GitHub App integration | see [[features/m4-github-app#Getting GitHub App credentials]] |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_TEAM` | billing | test-mode keys from dashboard.stripe.com |

Without the AI/GitHub/Stripe vars, the app still runs fully — those features
degrade gracefully (LLM review falls back to static-only findings; GitHub/
Stripe endpoints return `501 Not configured`).

## Running

```bash
npm run dev          # runs api + worker + web together (concurrently)
# or individually:
npm run dev:api       # Express API on :4000
npm run dev:worker     # BullMQ scan worker (no HTTP port)
npm run dev:web         # Vite dev server on :5173 (proxies /api to :4000)
```

Open **http://localhost:5173**, register an account (auto-creates a personal
org as `owner`), connect a public GitHub repo, click **Scan now**.

## Testing

```bash
npm run test:ground-truth --workspace server
```

Runs the analysis engine (manifest parse → import extraction → registry
check → dead-code candidate finder) directly against a seeded fixture at
`server/test/fixture/` with known-correct answers: one phantom package
(`react-toolkitz`), one unused real package, two dead exports, and two
symbols that must *not* be flagged (cross-file-referenced and an entry-point
name). 7 assertions, all passing as of last run.

## Preview tooling

`.claude/launch.json` defines two dev-server configs for the agent's preview
tooling: `codeaudit-web` (port 5173) and `codeaudit-api` (port 4000).

## Local ports in use

| Port | Service |
|---|---|
| 5173 | web (Vite) |
| 4000 | API (Express) |
| 5433 | Postgres (mapped from container's 5432 — avoids clashing with a default-port Postgres elsewhere on the machine) |
| 6380 | Redis (mapped from container's 6379, same reasoning) |

## Repo

Pushed to `https://github.com/DelTa-0/codeaudit` (private). `.env`, `.pem`
files, and `node_modules/` are all gitignored and were verified never
committed before the first push.
