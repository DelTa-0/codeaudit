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

> **The root [`README.md`](../README.md) is now the canonical, fully
> up-to-date setup + configuration reference** (quick start, every env var
> including the F2–F6 feature-pack additions, GitHub App walkthrough, all
> feature toggles). This page stays as a short vault-side pointer plus the
> things worth knowing that aren't just "how to run it."

## Prerequisites

- Node.js (v24 used in dev)
- Docker Desktop (for Postgres + Redis)

## First-time setup

See [README.md § Quick start](../README.md#quick-start) and
[§ Configuration reference](../README.md#configuration-reference) for the
full command sequence and every env var (core, LLM, GitHub App, Stripe).

Workspaces as of the feature pack: `packages/engine` (`@codeaudit/engine`,
shared analysis core), `server`, `web`, `cli` (`npx codeorion`) — `npm
install` at the repo root installs all four.

Migrations live in `server/migrations/`, numbered and applied in order by
`npm run migrate` (which applies whichever are pending). The latest is
`008_admin_console.sql` — platform role, presence, and the two log tables.

## Seeding the operator account

The admin console at `/admin` needs at least one account with
`users.platform_role = 'admin'`. Nothing has it by default:

```bash
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-passphrase' \
  npm run seed:admin --workspace server
```

Credentials come from the environment, never argv — argv lands in shell
history and is readable via `ps`. The script is idempotent: an existing
account is promoted (its password untouched unless
`ADMIN_RESET_PASSWORD=true`), a new one is created with a personal workspace.
Minimum password length is 12. See [[m7-admin-console]].

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
