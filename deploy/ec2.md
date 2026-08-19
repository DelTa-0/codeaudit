# Deploying CodeOrion to a single EC2 instance

The cheapest path to a working URL: one EC2 box running the API, the scan
worker, Postgres and Redis under `docker compose`. Roughly **$15-20/month**
(t3.small on-demand plus a 30GB gp3 volume).

The image is identical to the one the ECS setup uses, so nothing here has to be
rebuilt if you later move to Fargate — see [README.md](README.md) for that path.

**What you give up versus ECS:** one box means a deploy has a few seconds of
downtime, and backups are yours to run. Fine for early users; revisit when
downtime starts costing you something.

Steps 1-7 get you running on a raw IP. **GitHub login and Stripe webhooks will
not work until you finish step 8** — both refuse to call back to a bare IP.

---

## 1. Get AWS credentials working locally

Nothing else works until `aws sts get-caller-identity` succeeds. In the AWS
console, under **IAM → Users**, create a user for yourself, then under
**Security credentials** create an access key of type *Command Line Interface*.

Then, on your machine:

```bash
aws configure
```

Enter the access key ID, the secret key, `eu-central-1`, and `json`. Verify:

```bash
aws sts get-caller-identity
```

It must print your account ID. Keep the secret key somewhere safe — the console
shows it exactly once.

> If your organisation uses IAM Identity Center instead, run `aws configure sso`
> and then `aws sso login --profile <name>`, and append `--profile <name>` to
> every `aws` command below.

## 2. Push the image to ECR

Create the registry (once):

```bash
aws ecr create-repository --repository-name codeorion --region eu-central-1
```

Set your account and region, then log in, build, and push. Run this from the
repo root:

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGION=eu-central-1
REPO=$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/codeorion
```

```bash
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com
```

```bash
docker build --platform linux/amd64 -t $REPO:latest . && docker push $REPO:latest
```

`--platform linux/amd64` matters: an image built on an ARM Mac will not run on
an x86 instance, and the failure looks like an unhelpful `exec format error`.

## 3. Launch the instance

In **EC2 → Instances → Launch an instance**:

| Setting | Value |
| --- | --- |
| AMI | Amazon Linux 2023 |
| Type | `t3.small` (2 vCPU, 2GB) |
| Key pair | Create one, download the `.pem`, keep it safe |
| Storage | 30GB gp3 |
| Network | Auto-assign public IP **enabled** |

Security group inbound rules — exactly three:

| Port | Source | Why |
| --- | --- | --- |
| 22 | **My IP** | SSH. Never `0.0.0.0/0`. |
| 80 | `0.0.0.0/0` | The app (and later, ACME HTTP validation) |
| 443 | `0.0.0.0/0` | HTTPS, once you reach step 8 |

Do **not** open 5432 or 6379. Postgres and Redis stay on the container network;
nothing outside the box should reach them.

**Scan jobs are memory-hungry** — the worker parses whole repositories. If scans
start dying, move to `t3.medium`. Step 4 adds swap, which absorbs the smaller
spikes.

## 4. Let the instance pull from ECR

Rather than putting AWS keys on the box, give it an identity.

**IAM → Roles → Create role** → *AWS service* → *EC2* → attach the managed
policy **AmazonEC2ContainerRegistryReadOnly** → name it `codeorionEc2Role`.

Then **EC2 → your instance → Actions → Security → Modify IAM role** and attach
it. This takes effect immediately; no restart needed.

## 5. Install Docker on the box

SSH in (from the directory holding your key):

```bash
chmod 400 your-key.pem && ssh -i your-key.pem ec2-user@<PUBLIC_IP>
```

Then, on the instance:

```bash
sudo dnf update -y && sudo dnf install -y docker
sudo systemctl enable --now docker
sudo usermod -aG docker ec2-user
```

Compose is not in the Amazon Linux repos, so install the plugin directly:

```bash
mkdir -p ~/.docker/cli-plugins
curl -sSL https://github.com/docker/compose/releases/latest/download/docker-compose-linux-x86_64 -o ~/.docker/cli-plugins/docker-compose
chmod +x ~/.docker/cli-plugins/docker-compose
```

Add 2GB of swap so a build or a large scan cannot OOM-kill Postgres:

```bash
sudo dd if=/dev/zero of=/swapfile bs=1M count=2048 && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

**Log out and back in** — the `docker` group membership only applies to a new
session. Confirm with `docker ps` (it should not need `sudo`).

## 6. Configure the app

Copy the two deployment files up from your machine (run locally, in the repo
root):

```bash
scp -i your-key.pem deploy/docker-compose.prod.yml deploy/.env.prod.example ec2-user@<PUBLIC_IP>:~/
```

Back on the instance, generate the secrets and create `.env`:

```bash
mv .env.prod.example .env && openssl rand -hex 32
```

Edit `.env` (`nano .env`) and fill in at minimum:

- `IMAGE` — your ECR URI from step 2, ending `:latest`
- `POSTGRES_PASSWORD` — a generated value
- `JWT_SECRET` — a *different* generated value
- `APP_URL` and `API_URL` — both `http://<PUBLIC_IP>` for now

Then lock it down, since it now holds every secret the app has:

```bash
chmod 600 .env
```

## 7. Deploy and verify

Log in to ECR from the box (the instance role supplies the credentials):

```bash
aws ecr get-login-password --region eu-central-1 | docker login --username AWS --password-stdin $(grep '^IMAGE=' .env | cut -d/ -f1 | cut -d= -f2)
```

Start the datastores, run migrations once, then bring up the app:

```bash
docker compose -f docker-compose.prod.yml up -d postgres redis
```

```bash
docker compose -f docker-compose.prod.yml run --rm api node server/dist/db/migrate.js
```

```bash
docker compose -f docker-compose.prod.yml up -d
```

Check it:

```bash
curl -s localhost/api/health && docker compose -f docker-compose.prod.yml ps
```

You want `{"ok":true}`, `api` reporting `healthy`, and `worker` reporting `Up`.
Then open `http://<PUBLIC_IP>` in a browser — the dashboard should load, and you
can register an email/password account and scan a public repository.

If the API will not start, `docker compose -f docker-compose.prod.yml logs api`
almost always names the missing env var directly: config fails fast on startup.

## 8. Domain and HTTPS

Required before GitHub login, private-repo scanning, or Stripe will work.
Browsers also block some APIs on plain HTTP.

Point an `A` record at the instance's public IP. Give it an **Elastic IP** first
(**EC2 → Elastic IPs → Allocate**, then associate) or the address changes every
time the instance stops.

Add Caddy, which obtains and renews certificates automatically. On the box,
create `Caddyfile`:

```
your-domain.example {
    reverse_proxy api:4000
}
```

Create `docker-compose.tls.yml`:

```yaml
services:
  api:
    ports: !reset []     # stop publishing 80 directly; Caddy fronts it now
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddydata:/data
    depends_on: [api]

volumes:
  caddydata:
```

Update `APP_URL` and `API_URL` in `.env` to `https://your-domain.example`, then
bring it up **passing both files**:

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.tls.yml up -d
```

> Both `-f` flags are required, every time. Compose only auto-merges a file
> named `docker-compose.override.yml` when you let it pick up the default
> `docker-compose.yml`; the moment you pass `-f` explicitly, automatic merging
> stops. Miss the second flag and Caddy silently never starts while the API
> quietly goes on publishing port 80 unencrypted.

To save typing it forever, pin both files once per shell session:

```bash
echo 'export COMPOSE_FILE=docker-compose.prod.yml:docker-compose.tls.yml' >> ~/.bashrc && source ~/.bashrc
```

With that set you can drop the `-f` flags from every command below.

Certificate issuance takes a few seconds on first request. `docker compose logs
caddy` shows the ACME exchange if it does not.

## Day-two operations

These commands assume you are still pre-TLS. Once step 8 is done, either add
`-f docker-compose.tls.yml` to each or set `COMPOSE_FILE` as shown above.

**Deploy a new version.** Build and push from your machine (step 2), then on the
box:

```bash
docker compose -f docker-compose.prod.yml pull && docker compose -f docker-compose.prod.yml up -d
```

Run `docker compose -f docker-compose.prod.yml run --rm api node
server/dist/db/migrate.js` first whenever the release adds files under
`server/migrations/`.

**Seed the admin console operator.** Needed once per environment, after the
first deploy that includes `008_admin_console.sql`. Nothing has
`platform_role = 'admin'` by default, so `/admin` is unreachable until this
runs — which is the intended default, not a bug.

The `api` service reads the box's `.env`, so put the credentials there rather
than on the command line, where they would land in shell history and in `ps`:

```bash
nano .env      # add ADMIN_EMAIL= and ADMIN_PASSWORD= (12+ chars)
docker compose -f docker-compose.prod.yml run --rm api node server/dist/db/seedAdmin.js
nano .env      # remove both lines again — the seed only needs them once
```

The script is idempotent: run it again to promote a second operator, or with
`ADMIN_RESET_PASSWORD=true` to change an existing one's password. Use a
different password from any other environment — this account reads every
tenant's logs.

**Logs.**

```bash
docker compose -f docker-compose.prod.yml logs -f --tail 100 api worker
```

**Back up the database.** Nothing does this for you on a single box:

```bash
docker compose -f docker-compose.prod.yml exec -T postgres pg_dump -U codeorion codeorion | gzip > backup-$(date +%F).sql.gz
```

Copy it off the instance — a backup that only exists on the box being backed up
is not a backup. Worth a cron job to S3 once you have real users.

**Disk.** The worker clones repositories into the container's `/tmp` and cleans
up per job, but a crashed job can leave directories behind. `df -h` if things
get strange; `docker system prune -a` reclaims old images after a few deploys.
