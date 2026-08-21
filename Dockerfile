# syntax=docker/dockerfile:1

# One image, three run-modes (selected by the container command in ECS):
#   API       → node server/dist/index.js   (default; also serves the web app)
#   Worker    → node server/dist/worker.js   (needs the git binary, baked below)
#   Migration → node server/dist/db/migrate.js  (run once before first serve)
#
# Every stage is rooted at /app. Do not change that: @codeaudit/engine is a
# workspace dependency resolved by a symlink at node_modules/@codeaudit/engine
# -> ../../packages/engine, and a different directory shape breaks it.

ARG NODE_IMAGE=node:20-bookworm-slim

# ---- Deps: full workspace install, cached on the manifests alone ----------
FROM ${NODE_IMAGE} AS deps
WORKDIR /app

# Copy manifests first so `npm ci` is cached until a dependency actually changes.
# All five workspaces must be present or npm's workspace install fails.
COPY package.json package-lock.json ./
COPY packages/engine/package.json packages/engine/
COPY server/package.json server/
COPY web/package.json web/
COPY cli/package.json cli/
COPY mcp/package.json mcp/

RUN npm ci

# ---- Builder: compile engine → server (tsc) → web (vite), then shed dev deps
FROM deps AS builder
WORKDIR /app

COPY . .
RUN npm run build

# Prune in place rather than running a second `npm ci --omit=dev` in a separate
# stage. That install reproducibly tripped an npm bug ("Exit handler never
# called!") which exits 0 while leaving the tree incomplete — it produced an
# EMPTY node_modules/@babel/parser directory, so an image that built green
# failed to import the engine at runtime. Pruning reuses the install that
# already succeeded, so there is no second chance to get it wrong.
RUN npm prune --omit=dev

# ---- Runtime: slim image with git for the worker's repo clones -----------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app

# git:             the worker shells out to it for shallow clones + git-history
#                  attribution (simple-git). Without it, scans fail at runtime.
# ca-certificates: TLS trust for RDS/ElastiCache, the npm/PyPI registries,
#                  OSV.dev, and LLM HTTPS calls.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Only the built output and production dependencies cross into the runtime
# stage — not the source tree, tsc, vite, or tsx. The package.json files come
# too: node reads "type": "module" from the nearest one to treat the emitted
# .js as ESM, and the engine's "exports" map is what resolves
# @codeaudit/engine/secrets.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/engine/package.json packages/engine/
COPY --from=builder /app/packages/engine/dist         packages/engine/dist
COPY --from=builder /app/server/package.json server/
COPY --from=builder /app/server/dist         server/dist

# migrate.js resolves ../../migrations relative to itself, i.e. server/migrations.
COPY server/migrations server/migrations

# The API serves the built React bundle from here, same origin (see index.ts).
COPY --from=builder /app/web/dist web/dist
ENV WEB_DIST_DIR=/app/web/dist

# The scan sandbox clones into os.tmpdir()/codeaudit-scans and cleans up per job.
RUN mkdir -p /tmp/codeaudit-scans && chown node:node /tmp/codeaudit-scans

# Nothing here needs root, and the worker clones untrusted repositories.
USER node

EXPOSE 4000

# Applies to the DEFAULT run-mode (the API). The worker serves no HTTP and would
# fail this forever — the ECS worker task definition drops healthCheck entirely
# (the worker serves no HTTP); for plain `docker run`, pass --no-healthcheck.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# No init is baked in: node would otherwise run as PID 1, where it neither
# reaps zombies (the worker spawns git children on every scan) nor gets the
# default SIGTERM handling ECS relies on to drain a job before the container
# dies. Rather than ship tini, use the runtime's own init — ECS
# `linuxParameters.initProcessEnabled: true` (set in the task definitions),
# or `docker run --init` locally. Both put a real init at PID 1 for free.

# API by default. Override `command` in the ECS task definition for the worker
# and the one-off migration task.
CMD ["node", "server/dist/index.js"]
