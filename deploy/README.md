# Deploying CodeOrion to AWS (ECR + ECS Fargate)

> **Want the cheap path instead?** [`ec2.md`](ec2.md) deploys the same image to
> a single EC2 box with `docker compose` for roughly $15-20/month, versus
> $70-110 here. Same image, so moving up to Fargate later needs no rebuild.
> This document is the production-grade option: rolling deploys, managed
> Postgres and Redis, independently scaled workers.

One Docker image runs all three server processes; they differ only by the
container **command**:

| Process   | Command                            | Runs as                         |
|-----------|------------------------------------|---------------------------------|
| API       | `node server/dist/index.js`        | ECS service (behind the ALB); also serves the web app same-origin |
| Worker    | `node server/dist/worker.js`       | ECS service (no load balancer)  |
| Migration | `node server/dist/db/migrate.js`   | One-off ECS task, run once before first serve and on schema changes |

The Dockerfile at the repo root builds this image. The React frontend is built
into the image and served by the API — there is no separate web service.

Three properties of the image that the task definitions have to cooperate with:

- **It runs as the non-root `node` user (uid 1000).** Any volume or mount point
  it must write to needs to be writable by that uid.
- **It bakes in no init**, so every task definition sets
  `linuxParameters.initProcessEnabled: true`. Without it node is PID 1, reaps
  no zombies (the worker spawns a `git` child per scan), and misses the default
  SIGTERM handling — ECS then kills tasks mid-job on deploy. Locally, use
  `docker run --init`.
- **It carries a `HEALTHCHECK` for the API run-mode only.** The worker serves no
  HTTP; its task definition must drop `healthCheck` (see below), and plain
  `docker run` of the worker wants `--no-healthcheck`.

## Prerequisites (provisioned once, outside this repo)

These need your AWS account and are **not** created by anything in this repo:

- **RDS PostgreSQL 16** — grab its connection string; TLS is on by default, so
  set `DATABASE_SSL=require`.
- **ElastiCache Redis** — with in-transit encryption, use a `rediss://` URL (or
  set `REDIS_TLS=true`).
- **ECR repository** named `codeorion`, with a lifecycle policy — see below.
- **ECS Fargate cluster**, an **ALB** with an ACM TLS cert, and a target group
  pointing at container port `4000` (health check path `/api/health`).
- **Secrets Manager** entries for `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, and
  any optional keys (`XAI_API_KEY`, `GITHUB_APP_PRIVATE_KEY`, Stripe). The GitHub
  App key goes in as PEM contents via `GITHUB_APP_PRIVATE_KEY` — no file needed.
- IAM roles: `ecsTaskExecutionRole` (pull image + read secrets) and a task role.

### Give the repository a lifecycle policy

Nothing prunes ECR on its own, and every deploy adds roughly 130 MB. Worse,
each push that moves the `latest` tag leaves the previous manifest behind
*untagged* — unreferenced, unpullable, and still billed. Left alone this repo
reached 65 images and 5.35 GB, two thirds of it images nobody could deploy
even if they wanted to.

```bash
aws ecr put-lifecycle-policy --repository-name codeorion --lifecycle-policy-text '{
  "rules": [
    { "rulePriority": 1,
      "description": "Expire untagged manifests after a day",
      "selection": { "tagStatus": "untagged", "countType": "sinceImagePushed", "countUnit": "days", "countNumber": 1 },
      "action": { "type": "expire" } },
    { "rulePriority": 2,
      "description": "Keep the 15 most recent images",
      "selection": { "tagStatus": "any", "countType": "imageCountMoreThan", "countNumber": 15 },
      "action": { "type": "expire" } }
  ]
}'
```

Preview before applying — `put-lifecycle-policy` takes effect on its own
schedule and there is no undo:

```bash
aws ecr start-lifecycle-policy-preview --repository-name codeorion --lifecycle-policy-text file://policy.json
```

```bash
aws ecr get-lifecycle-policy-preview --repository-name codeorion --query 'previewResults[?imageTags].imageTags'
```

> Check that `latest` and the currently deployed tag are absent from that
> list. ECR does not treat `latest` as special: a policy that counts images
> will happily expire it if it is old enough, and the first sign is a
> deploy that cannot pull.

## 1. Build and push the image to ECR

```bash
ACCOUNT_ID=<your-account-id>
REGION=<your-region>
REPO=$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/codeorion

aws ecr get-login-password --region $REGION \
  | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com

docker build -t codeorion:latest .
docker tag codeorion:latest $REPO:latest
docker push $REPO:latest
```

> Building on Apple Silicon / ARM for Fargate x86? Add
> `--platform linux/amd64` to `docker build`.

## 2. Register the task definitions

Edit [`ecs-task-def.example.json`](ecs-task-def.example.json) — fill in
`<ACCOUNT_ID>`, `<REGION>`, the image tag, and the Secrets Manager ARNs — then:

```bash
aws ecs register-task-definition --cli-input-json file://deploy/ecs-task-def.example.json
```

For the **worker**, copy that file to a `codeorion-worker` family, change
`command` to `["node","server/dist/worker.js"]`, and drop the `portMappings`
and `healthCheck` (it has no HTTP surface).

## 3. Run migrations (one-off task, before first serve)

Same image, migration command, in your VPC subnets/security group so it can
reach RDS:

```bash
aws ecs run-task \
  --cluster codeorion \
  --launch-type FARGATE \
  --task-definition codeorion-api \
  --overrides '{"containerOverrides":[{"name":"api","command":["node","server/dist/db/migrate.js"]}]}' \
  --network-configuration 'awsvpcConfiguration={subnets=[subnet-xxx],securityGroups=[sg-xxx],assignPublicIp=DISABLED}'
```

Re-run this whenever you add a migration under `server/migrations/`.

## 4. Create the services

- **API service** — task def `codeorion-api`, attached to the ALB target group
  on port 4000. The ALB's HTTPS listener is the public entry point; `APP_URL`
  and `API_URL` must be the ALB/domain HTTPS URL so CORS and same-origin
  serving line up.
- **Worker service** — task def `codeorion-worker`, desired count ≥ 1, no load
  balancer.

## 5. Verify

```bash
curl https://your-domain.example/api/health   # -> {"ok":true}
```

Then open the domain in a browser — the API serves the dashboard from the same
origin, so the SPA and its `/api` calls share one hostname (no CORS config
beyond `APP_URL`).

## Local parity check (what was verified before shipping this)

The exact image was booted against the repo's `docker compose` Postgres/Redis:
migrations applied, `/api/health` returned `{"ok":true}`, `/` served the built
React app, `/dashboard` fell back to the SPA, and unknown `/api/*` paths
returned JSON (the SPA fallback does not shadow the API). Reproduce locally:

```bash
docker compose up -d
docker build -t codeorion:local .
docker run --rm --init -e DATABASE_URL="postgres://codeaudit:codeaudit@host.docker.internal:5433/codeaudit" \
  -e JWT_SECRET=local codeorion:local node server/dist/db/migrate.js
docker run -d --name codeorion-api --init -p 4100:4000 \
  -e DATABASE_URL="postgres://codeaudit:codeaudit@host.docker.internal:5433/codeaudit" \
  -e REDIS_URL="redis://host.docker.internal:6380" \
  -e JWT_SECRET=local -e APP_URL="http://localhost:4100" codeorion:local
curl http://localhost:4100/api/health
```

The worker adds `--no-healthcheck` (it has no HTTP surface, so the image's
API-oriented healthcheck would report a perfectly healthy worker as unhealthy):

```bash
docker run -d --name codeorion-worker --init --no-healthcheck \
  -e DATABASE_URL="postgres://codeaudit:codeaudit@host.docker.internal:5433/codeaudit" \
  -e REDIS_URL="redis://host.docker.internal:6380" \
  -e JWT_SECRET=local codeorion:local node server/dist/worker.js
```

## A note on secrets in the image

`.dockerignore` is a security control for this build, not housekeeping. The
Dockerfile does `COPY . .`, so anything not ignored is baked into a layer and
pushed to ECR, where it is readable by anyone who can pull the image.

A bare `.env` line matches only the repo root. A normal dev checkout also has
`server/.env`, which was therefore still being copied in — confirmed by
inspecting a locally built image and finding `/app/server/.env` with live
`JWT_SECRET`, `DATABASE_URL`, `XAI_API_KEY`, and `GITHUB_CLIENT_SECRET` values.
The ignore file now uses `**/.env` and `**/.env.*` forms. **If an image built
before that fix was ever pushed or shared, treat those credentials as disclosed
and rotate them.**
