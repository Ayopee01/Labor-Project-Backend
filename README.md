# Backend API Structure

Backend Express API for labor/user management.

The project supports two development modes:

- Local development on a developer machine
- Shared development/test deployment on a self-managed DigitalOcean Droplet — the same droplet
  also runs production; see **Deploying to DigitalOcean** below. There is no separate hosted
  environment for dev/test.

The shared droplet deployment provides a single public Backend Base URL for:

- Frontend integration
- Postman testing
- LINE OA webhook testing
- WebSocket testing
- Integration testing

Prisma owns the PostgreSQL schema, migrations, seed, and database client.

## API Documentation

Full API reference (Swagger UI) for the shared droplet dev deployment:

https://\<your-domain\>/api-docs/

(nginx/TLS termination is configured directly on the droplet, outside this repo — see **Deploying to DigitalOcean** below.)

## Stack

- Node.js
- Express.js
- PostgreSQL
- Redis / Redis-compatible Key Value
- BullMQ
- Prisma ORM
- TypeScript compiled to CommonJS
- Docker
- GitHub Actions CI
- DigitalOcean Droplet (self-managed, Docker Compose) for both production and shared dev/test deployment — nginx/TLS is configured directly on the host, outside Docker Compose

## Local Development Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Fill in the token secrets (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_LOGIN_CHALLENGE_SECRET`, `REFRESH_TOKEN_HASH_SECRET`) with any local values.

### 3. Start PostgreSQL and Redis

Redis is required for the app to start (BullMQ/ioredis). PostgreSQL can either run in Docker or be an existing local install.

**Option A — Postgres + Redis in Docker (no local Postgres install needed):**

```bash
docker compose --profile local-db up -d postgres redis
```

> The compose `postgres` service binds to host port `5434` by default, while `.env.example`'s `DATABASE_URL` points at port `5433`. Either add `POSTGRES_HOST_PORT=5433` to your `.env`, or change `DATABASE_URL`'s port to `5434` to match.

**Option B — Use an existing local PostgreSQL install:**

```bash
npm run docker:redis
```

Point `DATABASE_URL` in `.env` at your local PostgreSQL instance.

### 4. Generate the Prisma client and apply migrations

```bash
npm run db:generate
npm run db:migrate
```

### 5. Seed initial data

```bash
npm run db:seed
```

This creates the initial admin account and master data required to log in.

### 6. Start the dev server

```bash
npm run dev
```

The API listens on `http://localhost:8080` (from `PORT` in `.env`), with Swagger UI at `http://localhost:8080/api-docs`.

### Alternative: run the API itself in Docker too

`npm run docker:up` (`docker compose up --build`) builds and runs the `api` and `redis` services. By default it expects PostgreSQL to be reachable from inside the container via `DOCKER_DATABASE_URL` (defaults to `host.docker.internal:5433`, i.e. a PostgreSQL instance running on your host machine). To also run PostgreSQL in Docker, use `docker compose --profile local-db up --build` instead and set `DOCKER_DATABASE_URL` to `postgresql://postgres:password@postgres:5432/labor_project`.

The `api` container runs `npm run db:generate` automatically on startup, but migrations and seeding still need to be run manually, e.g.:

```bash
docker compose exec api npm run db:migrate
docker compose exec api npm run db:seed
```

`docker-compose.yml` also has an `api-prod` service (gated behind the `production` profile) for self-managed production deployments — it builds the `production` Docker target instead of `dev`, runs the compiled `dist/` build with no source bind-mount, and sets `NODE_ENV=production` correctly. It is not used for local development; see the log stack section below for how it's typically started together with logging.

## Running Tests

```bash
npm test
```

Runs unit tests and route tests (`test:unit` + `test:routes`). `npm run test:integration` additionally requires a real, isolated test database — `DATABASE_URL` must include `test` in its name (enforced in `test/setup/test-env.ts`).

## Logging & Error Tracking

Every request is logged once it completes, as a single structured JSON line to stdout (via [pino](https://getpino.io)) — never to a local file, so Promtail can ship it straight off the Docker log driver (see the self-hosted log stack section below) with no app-side log file to manage. Fields logged per request:

- `requestId` — from the inbound `X-Request-Id` header, or a generated UUID if not sent. Always echoed back in the `X-Request-Id` response header, and included in every error response body so a user can report an issue and the team can find the matching log line fast.
- `method`, `path`, `statusCode`, `durationMs`
- `clientType` — `worker_app` / `admin_webapp` / `driver_webapp` / `gate` / `line_oa` / `unknown`, detected from the URL path prefix first, then (for the shared `/api/auth` routes only) from the authenticated account's role, then from an `X-Client-Type` header, then `unknown` — see `src/utils/client-type.ts`
- `clientVersion` — from an optional `X-Client-Version` header
- `userId` — the authenticated account id, when present
- `ip`

Log level follows the response status code: `>=500` → `error`, `>=400` → `warn`, otherwise → `info`.

**Sensitive data**: passwords, tokens, secrets, and `Authorization` headers are redacted (`[REDACTED]`) before anything is logged, via `src/utils/logger.ts`'s `redact()` — this applies to every `logger.*` call in the codebase, including the 5xx error log's request body, so this never needs to be handled per-endpoint.

**5xx errors** additionally log full context (`requestId`, `path`, `userId`, `clientType`, the redacted request body, stack trace) and are reported to [Sentry](https://sentry.io) with the same `requestId`/`clientType`/`userId` attached as tags/user context (`src/middlewares/error.middleware.ts`). Sentry is a no-op until `SENTRY_DSN` is set.

**Viewing logs**: `docker compose logs -f api-prod` on the droplet shows raw JSON lines directly; every line is a JSON object, filter/search by any field above (e.g. `requestId` from an error response, or `clientType`). For a searchable UI across history instead of tailing raw output, use Grafana + Loki — see **Self-Hosted Log Stack** below.

**Configuring Sentry**: set `SENTRY_DSN` in `.env` (see `.env.example`) — a no-op until set.

Logs are raw JSON lines in every environment, including local development.

## Self-Hosted Log Stack (Grafana + Loki + Promtail)

For a self-managed deployment (e.g. a DigitalOcean droplet) without an external log service, `docker-compose.yml` includes a self-hosted log stack gated behind the `logging` profile, so it never affects local development (plain `docker compose up` is unchanged). Promtail reads the `api`/`api-prod` container's stdout JSON logs directly through the Docker logging driver (no app-side changes, no extra log file mounts) and ships them to Loki; Grafana comes with Loki pre-provisioned as a data source.

**Starting it** (alongside the production API — see `docker-compose.yml`'s `api-prod` service, gated behind the `production` profile for the same reason):

```bash
GRAFANA_ADMIN_USER=admin GRAFANA_ADMIN_PASSWORD=<a-real-password> \
  docker compose --profile production --profile logging up -d redis api-prod loki promtail grafana
```

> **List the service names explicitly, as above — do not run a bare `docker compose --profile production --profile logging up -d` with no service names.** Both `api` (the local-dev service, unprofiled and therefore always eligible to start) and `api-prod` bind the same host port `8080`, so an unnamed `up` would try to start both and fail on a port conflict. Naming services explicitly (as above) starts only what's listed and skips `api` entirely — verified by actually running this on this exact `docker-compose.yml`.

(or set `GRAFANA_ADMIN_USER`/`GRAFANA_ADMIN_PASSWORD` in the droplet's `.env` instead of inline — see `.env.example`.) If left unset, Grafana falls back to its own insecure `admin`/`admin` default — always set a real password before exposing the port below.

Also add `postgres` to that service list if this droplet also runs PostgreSQL in Docker (i.e. you're additionally using the `local-db` profile from the Local Development Setup section above) — it isn't included by default here since many production setups instead point `DATABASE_URL` at an external managed Postgres.

**Viewing logs**: open `http://<droplet-ip>:3000`, log in with the admin credentials above, then **Explore** → **Loki** → query e.g. `{service="api-prod"}` (or `{service="api"}` if you're pointed at a local-dev container instead).

**Restrict Grafana's port to your team only (required before exposing it on a public host)** — the admin password is the only auth layer in front of port 3000, so also firewall it at the OS level with UFW on the droplet itself. This is a **manual command you run yourself directly on the droplet, once** — it is not part of `docker-compose.yml` and nothing in this repo runs it automatically:

```bash
# 1. Replace YOUR_TEAM_IP with your actual team IP(s)/CIDR first — this is a placeholder.
# 2. Run these ONE AT A TIME and check you're not locked out after each step, in this exact
#    order. Getting the order wrong (e.g. enabling UFW or denying a port before explicitly
#    allowing SSH) can lock you out of the droplet entirely, with no way back in except the
#    provider's web console.
sudo ufw allow 22/tcp                                          # SSH — do this first, always
sudo ufw allow from YOUR_TEAM_IP to any port 3000 proto tcp     # Grafana, team IP only
sudo ufw deny 3000/tcp                                          # Grafana, deny everyone else
sudo ufw enable                                                 # only enable after the rules above
sudo ufw status verbose                                         # confirm SSH (22) is allowed before disconnecting
```

**Retention**: Loki is configured for 14 days (`monitoring/loki-config.yaml`'s `retention_period`) — set conservatively because the droplet's disk size wasn't known at setup time. Once real disk usage is confirmed comfortable (check with `docker exec labor-loki du -sh /loki` after the stack has been running a while), this can be raised to 30 days by editing that one value and restarting the `loki` container — no data migration needed. Consider also enabling DigitalOcean's built-in Droplet disk-usage monitoring/alerts as a safety net independent of Loki's own retention.

**Backup**: this is a self-managed VM — there is no automatic backup of the `loki_data` volume the way a managed logging service would provide. Back it up periodically (e.g. `docker run --rm -v labor-project-backend_loki_data:/loki -v $(pwd):/backup alpine tar czf /backup/loki-backup-$(date +%F).tar.gz /loki`) if historical logs need to survive a lost/corrupted droplet, or treat log history as disposable if it doesn't.

## Deploying to DigitalOcean (self-managed droplet)

This is the only deployment target for the project — the same droplet serves both production and the shared dev/test environment described at the top of this README (a second droplet, if the team wants environments physically separated, would just repeat these same steps). It runs the `api-prod` and (optionally) `postgres`/log-stack services from `docker-compose.yml` via Docker Compose, on a DigitalOcean Droplet (Ubuntu 24.04 LTS). nginx and TLS (Let's Encrypt or otherwise) are set up directly on the host, outside this repo — `api-prod` just listens on port 8080 for whatever reverse proxy you put in front of it.

### 1. Provision the droplet and install Docker

- Create the droplet (2 vCPU/4GB is the tested baseline), SSH in.
- Install Docker Engine + the Compose plugin (see Docker's official install docs for Ubuntu).
- `git clone` this repo onto the droplet.

### 2. Configure `.env`

```bash
cp .env.example .env
```

Fill in every `CHANGE_ME*` placeholder — see the **Pre-deploy secret checklist** below.

### 3. Start the stack

```bash
docker compose --profile production up -d redis api-prod
```

To also run PostgreSQL in Docker on this droplet instead of an external managed database, add `postgres` to the service list and the `local-db` profile, e.g. `docker compose --profile production --profile local-db up -d redis postgres api-prod`.

For the optional log stack (Grafana + Loki + Promtail), see the **Self-Hosted Log Stack** section above — it's the same `--profile production --profile logging` pattern.

### 4. Set up nginx + HTTPS on the host

nginx and TLS are managed directly on the droplet (outside Docker Compose) — set up nginx as a reverse proxy to `127.0.0.1:8080` (where `api-prod` listens) and obtain a certificate (e.g. via `certbot --nginx`) however fits your setup.

### 5. Verify

- `curl https://<your-domain>/ready` should return healthy.
- `docker compose ps` — all expected services `Up`/healthy.

### 6. Set up CI/CD auto-deploy (optional)

Once the droplet is up and steps 1–5 above have been done manually at least once, `.github/workflows/ci.yml` can deploy every subsequent push to `main` automatically: after the existing build/test job passes, a `deploy` job SSHes into the droplet, fast-forwards the existing git checkout to `origin/main`, and restarts the production containers with a fresh build (`docker compose --profile production up -d --build redis api-prod`). It only runs on `push` to `main` (not on pull requests, and not on `develop`), and only after `build-test` succeeds.

Set these **GitHub repository secrets** (Settings → Secrets and variables → Actions) for it to work:

| Secret | Value |
|---|---|
| `DEPLOY_HOST` | The droplet's IP address (or domain) |
| `DEPLOY_USER` | SSH user on the droplet (a dedicated deploy user is preferable to a personal login) |
| `DEPLOY_SSH_KEY` | The **private** key for a dedicated deploy key pair — generate one just for this (`ssh-keygen -t ed25519 -f deploy_key -N ""`), add `deploy_key.pub` to that user's `~/.ssh/authorized_keys` on the droplet, and paste the contents of `deploy_key` (the private half) into this secret. Never reuse a personal SSH key here. |
| `DEPLOY_PATH` | Absolute path to this repo's git clone on the droplet (e.g. `/home/deploy/labor-project-backend`) |
| `DEPLOY_PORT` | Optional — only needed if SSH runs on a non-default port |

`git reset --hard origin/main` runs as part of the deploy step — safe because `.env` is gitignored (never touched by it) and the deploy path is expected to only ever be updated by this job, not edited by hand on the droplet.

Without `DEPLOY_HOST` set, the `deploy` job's SSH step is skipped (not failed) on every push to `main` (the rest of CI — typecheck/build/tests — is unaffected); leave the secrets unset if auto-deploy isn't wanted yet and keep deploying manually via steps 1–5. This also matters if a third-party service (e.g. Render) watches this repo's commit checks before deploying — a skipped step keeps the check green, whereas a hard SSH failure would not.

### UFW firewall

Same manual, one-command-at-a-time caution as the Grafana section above — **always allow SSH before enabling UFW**, or you can be locked out with no way back in except the provider's web console:

```bash
sudo ufw allow 22/tcp     # SSH — do this first, always
sudo ufw allow 80/tcp     # host nginx: HTTP (redirects to HTTPS, also serves the ACME challenge)
sudo ufw allow 443/tcp    # host nginx: HTTPS
sudo ufw enable           # only enable after the rules above
sudo ufw status verbose   # confirm SSH (22) is allowed before disconnecting
```

Port 3000 (Grafana) is deliberately **not** opened here — see the UFW rule in the log-stack section above, which restricts it to your team's IP(s) only. Postgres/Redis ports are not exposed publicly at all in `docker-compose.yml`'s production services.

### Database backups

Production PostgreSQL runs on a **DigitalOcean Managed Database** cluster, not in Docker on the droplet. Backups are handled entirely by DO itself — automatic daily backups with point-in-time recovery (7-day retention by default, extendable in the control panel under the cluster's **Backups & Restore** tab). There is no backup script or cron job in this repo to maintain.

To point the app at the cluster:

1. Provision the Managed Database cluster in the DigitalOcean control panel (same region as the droplet, to keep latency low).
2. Point `DATABASE_URL` (and `DOCKER_DATABASE_URL` if used) at the cluster's connection string, appending `?sslmode=require` — DO Managed Postgres requires SSL and refuses plain connections.
3. Don't add the `local-db` profile to the production start command — just `docker compose --profile production up -d redis api-prod` (no `postgres` service needed on the droplet).

**`loki_data` and whole-droplet safety net**: enable DigitalOcean's built-in **automatic daily Droplet snapshots** (Droplet → Backups, in the DigitalOcean control panel) — this covers `loki_data` and every other volume/file on the droplet as a single daily point-in-time image, independent of the database backups above.

### Pre-deploy secret checklist

Before starting the stack in production, replace every one of these in `.env` (all currently `CHANGE_ME*` placeholders in `.env.example`):

- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_LOGIN_CHALLENGE_SECRET`, `REFRESH_TOKEN_HASH_SECRET` — generate each separately: `openssl rand -base64 32`
- `DOCKER_DATABASE_URL` (and `DATABASE_URL` if used directly) — replace the `password` placeholder with a real generated password
- `CORS_ORIGIN` — the real frontend origin(s), not `*`
- `GRAFANA_ADMIN_PASSWORD` — required before exposing port 3000, even behind the UFW team-IP rule above
- `SPACES_ENDPOINT`, `SPACES_REGION`, `SPACES_ACCESS_KEY`, `SPACES_SECRET_KEY` — from the DigitalOcean control panel (API → Spaces Keys); required for the app to start at all (admin profile image uploads)
- `SPACES_ADMIN_BUCKET` — a public-read Spaces bucket for admin profile images
- `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET` — from the LINE Developers console
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` — from the Firebase service account JSON
- `SENTRY_DSN` — optional; leave empty to keep Sentry disabled