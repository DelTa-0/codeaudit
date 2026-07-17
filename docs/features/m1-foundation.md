---
type: feature
title: "M1 — Foundation"
created: 2026-07-17
updated: 2026-07-17
tags:
  - project/codeaudit
  - milestone
status: done
related:
  - "[[../index]]"
  - "[[../architecture]]"
  - "[[../database-schema]]"
---

# M1 — Foundation

## What it delivers

Monorepo scaffold, local infra, the multi-tenant data model, and
authentication — everything every later milestone builds on.

## Key pieces

- `npm` workspaces monorepo (`server/`, `web/`), `docker-compose.yml` for
  Postgres 16 + Redis 7
- Migration runner (`server/src/db/migrate.ts`) + initial schema
  (`001_core.sql`) — see [[../database-schema]]
- JWT auth (`routes/auth.ts`): register/login/`GET /auth/me`. Registration
  auto-creates a personal organization with the new user as `owner`
- Org/role model (`routes/orgs.ts`): create org, list/invite/manage members,
  role changes gated to `owner`, invite-accept flow with email-match check
- `middleware/auth.ts`: `requireAuth` (JWT verify) + `requireOrgRole(min)`
  (loads the caller's membership row, enforces a role hierarchy)
- `services/plans.ts`: `PLANS` table (free/pro/team limits) +
  `assertCanAddRepo`/`assertCanScan` guards, used by later milestones
- `services/audit.ts`: best-effort audit logging, never breaks the request path
- React shell: auth pages, `AuthProvider` context, protected-route wrapper,
  `Layout` with org switcher chip

## Verification performed

- `npm install` across both workspaces succeeded
- `docker compose up -d` → both containers healthy
- `npm run migrate` applied `001_core.sql` cleanly
- Registered a demo user via `curl`, confirmed JWT issued and `/auth/me`
  returns the auto-created personal org with `role: owner`
