# Deploying CodeOrion to AWS (ECR + ECS Fargate)

One Docker image runs all three server processes; they differ only by the
container **command**:

| Process   | Command                            | Runs as                         |
|-----------|------------------------------------|---------------------------------|
| API       | `node server/dist/index.js`        | ECS service (behind the ALB); also serves the web app same-origin |
| Worker    | `node server/dist/worker.js`       | ECS service (no load balancer)  |
| Migration | `node server/dist/db/migrate.js`   | One-off ECS task, run once before first serve and on schema changes |

The Dockerfile at the repo root builds this image. The React frontend is built
into the image and served by the API — there is no separate web service.

## Prerequisites (provisioned once, outside this repo)

These need your AWS account and are **not** created by anything in this repo:

- **RDS PostgreSQL 16** — grab its connection string; TLS is on by default, so
  set `DATABASE_SSL=require`.
- **ElastiCache Redis** — with in-transit encryption, use a `rediss://` URL (or
  set `REDIS_TLS=true`).
- **ECR repository** named `codeorion`.
- **ECS Fargate cluster**, an **ALB** with an ACM TLS cert, and a target group
  pointing at container port `4000` (health check path `/api/health`).
- **Secrets Manager** entries for `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, and
  any optional keys (`XAI_API_KEY`, `GITHUB_APP_PRIVATE_KEY`, Stripe). The GitHub
  App key goes in as PEM contents via `GITHUB_APP_PRIVATE_KEY` — no file needed.
- IAM roles: `ecsTaskExecutionRole` (pull image + read secrets) and a task role.

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
docker run --rm -e DATABASE_URL="postgres://codeaudit:codeaudit@host.docker.internal:5433/codeaudit" \
  -e JWT_SECRET=local codeorion:local node server/dist/db/migrate.js
docker run -d --name codeorion-api -p 4100:4000 \
  -e DATABASE_URL="postgres://codeaudit:codeaudit@host.docker.internal:5433/codeaudit" \
  -e REDIS_URL="redis://host.docker.internal:6380" \
  -e JWT_SECRET=local -e APP_URL="http://localhost:4100" codeorion:local
curl http://localhost:4100/api/health
```
