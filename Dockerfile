# syntax=docker/dockerfile:1

# One image, three run-modes (selected by the container command in ECS):
#   API       → node server/dist/index.js   (default; also serves the web app)
#   Worker    → node server/dist/worker.js   (needs the git binary, baked below)
#   Migration → node server/dist/db/migrate.js  (run once before first serve)

# ---- Builder: install every workspace and compile engine + server + web ----
FROM node:20-bookworm-slim AS builder
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

# Bring in the source and build engine → server (tsc) → web (vite).
COPY . .
RUN npm run build

# ---- Runtime: slim image with git for the worker's repo clones ----
FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# git:            the worker shells out to it for shallow clones + git-history
#                 attribution (simple-git). Without it, scans fail at runtime.
# ca-certificates: TLS trust for RDS/ElastiCache, the npm/PyPI registries,
#                 OSV.dev, and LLM HTTPS calls.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Copy the fully-built workspace across. This preserves the @codeaudit/engine
# workspace symlink and all resolved node_modules, so no re-resolution is needed
# at runtime. (Trades image size for correctness; pruning dev deps is a later
# optimization, not a blocker.)
COPY --from=builder /app ./

# The API serves the built React bundle from here, same origin (see index.ts).
ENV WEB_DIST_DIR=/app/web/dist

EXPOSE 4000

# API by default. Override `command` in the ECS task definition for the worker
# and the one-off migration task.
CMD ["node", "server/dist/index.js"]
