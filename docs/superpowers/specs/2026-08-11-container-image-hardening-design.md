---
type: spec
title: "Container image hardening for ECR"
created: 2026-08-11
updated: 2026-08-11
tags:
  - project/codeaudit
  - deployment
  - security
  - spec
status: implemented
related:
  - "[[architecture]]"
---

# Container image hardening for ECR

Hardens the production image introduced by `d215c37`. The architecture is
unchanged — one image, three run-modes, the API serving the web bundle
same-origin. What changes is a confirmed secret leak, the shipped contents of
the runtime stage, the identity it runs as, and its behaviour under SIGTERM.

## Why

The original build did `COPY . .` in the builder and then
`COPY --from=builder /app ./` into the runtime stage. That is simple and it
worked, but it means the shipped image is the entire build tree: source,
devDependencies, and anything in the context the ignore file missed. Four
consequences, in descending order of severity.

### 1. Live credentials were baked into the image (confirmed, not theoretical)

`.dockerignore` listed `.env` and `.env.*`. Those patterns match only the repo
root. A normal dev checkout also has `server/.env`, which was copied in and
shipped.

This was verified by inspecting `codeorion:local` — an image built from this
branch before the fix — and finding `/app/server/.env` containing real
`JWT_SECRET`, `DATABASE_URL`, `XAI_API_KEY`, and `GITHUB_CLIENT_SECRET` values.
Anyone able to pull such an image from ECR could read them.

Fixed by adding the `**/.env`, `**/.env.*`, `**/*.pem`, and `**/*.key` forms.
**Any image built before this fix must be treated as having disclosed those
credentials if it was ever pushed or shared, and they should be rotated.**

### 2. The runtime shipped its own build toolchain

`typescript`, `tsx`, `vite`, every `@types` package, and the full source tree
were present in the deployed image. That is dead weight and needless attack
surface in a container that clones untrusted repositories.

Now the builder runs `npm prune --omit=dev` after `npm run build`, and the
runtime stage copies only `node_modules`, the two `dist` trees, the
`package.json` files node needs for ESM resolution, `server/migrations`, and
`web/dist`. 658MB → 579MB.

`vite` and `tsx` legitimately survive the prune: `@tailwindcss/vite` is a
*production* dependency of `web` and pulls them transitively. Moving
`tailwindcss` and `@tailwindcss/vite` to `web`'s `devDependencies` would drop
them, but that edits an application manifest and its lockfile, so it is left as
a follow-up rather than folded into a deployment change.

### 3. It ran as root

Nothing in the image needs root, and the worker clones arbitrary third-party
repositories. It now runs as the base image's `node` user (uid 1000), with
`/tmp/codeaudit-scans` pre-created and owned by it.

### 4. Node ran as PID 1

As PID 1, node reaps no zombies — and the worker spawns a `git` child on every
scan — and does not get the default SIGTERM handling, so ECS killed tasks
mid-job on deploy rather than letting BullMQ release the in-flight job.

Rather than add a `tini` package, the fix uses the runtime's own init:
`linuxParameters.initProcessEnabled: true` in the task definitions, `--init`
locally. Same result, one fewer thing in the image.

## Deliberate non-changes

- **Base image stays `node:20-bookworm-slim`.** Alpine would be smaller, but
  swapping glibc for musl is an unrelated risk in a change about hardening.
- **`npm ci --omit=dev` in a separate stage was tried and abandoned.** With
  `--workspace` flags it reproducibly tripped an npm bug (`Exit handler never
  called!`) that exits 0 while leaving the tree incomplete — it produced an
  empty `node_modules/@babel/parser` directory, so an image that built green
  failed to import the engine at runtime. Pruning the install that already
  succeeded has no second chance to get it wrong.
- **A `HEALTHCHECK` is in the image but covers the API run-mode only.** The
  worker has no HTTP surface; its task definition drops `healthCheck` and local
  runs pass `--no-healthcheck`. Reproduced the failure first: an inherited
  healthcheck drives a healthy worker to `unhealthy` at `failing-streak=3`.

## Verification (performed 2026-08-11)

Built and exercised against the repo's compose Postgres and Redis:

- Secret leak: `/app/server/.env` present in the pre-fix image, absent after.
- `migrations up to date` against the live database.
- `/api/health` → `{"ok":true}`; `/` serves the built SPA; `/dashboard` returns
  200 with the SPA shell; unknown `/api/*` returns JSON, so the fallback does
  not shadow the API; hashed assets serve as `application/javascript`.
- Worker logs `Scan worker ready`.
- `id` reports uid 1000; `/proc/1/comm` reports `docker-init` under `--init`.
- `docker stop` yields exit code 143 (SIGTERM), not 137 (SIGKILL).
- `@codeaudit/engine` and both subpath exports import cleanly; `@babel/parser`
  parses — the workspace symlink and pruned tree are intact.

Not covered: a real scan job end to end (needs GitHub credentials), and
applying the task definitions to a live ECS cluster.
