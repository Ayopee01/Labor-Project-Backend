# Deployment

The backend runs on **DigitalOcean App Platform** as a single instance. App Platform watches the `main` branch of the GitHub repository: every push to `main` builds a new image from the repository's `Dockerfile` and replaces the running container. There is no server to manage, no reverse proxy to configure and no deploy script in this repo.

| Part | Where it runs |
| --- | --- |
| API | App Platform web service, built from `Dockerfile` (final `production` stage) |
| PostgreSQL | DigitalOcean Managed Database |
| Redis | Managed Redis, connected through `REDIS_URL` |
| Profile images | DigitalOcean Spaces |
| Errors | Sentry |

## Deployment Flow

```text
Developer
    |
    | git push origin main
    v
GitHub Repository ----> GitHub Actions CI (typecheck, build, tests)
    |
    v
DigitalOcean App Platform
    |-- build image from Dockerfile (production stage)
    |-- start container: npm run db:deploy (prisma migrate deploy) -> node dist/index.js
    |-- health check: GET /ready
    `-- switch traffic to the new container once healthy
```

- **Migrations** run on every container start (`npm run db:deploy` in the `Dockerfile` `CMD`) before the server listens. A migration that drops or renames a column breaks the previous build while it is still running, so deploy that code first and let its start apply the migration.
- **Health check**: `GET /ready` (also used by the `Dockerfile` `HEALTHCHECK`). App Platform keeps the old container serving until the new one is healthy.
- **Graceful shutdown**: `node` runs as PID 1, so it receives `SIGTERM` directly and finishes in-flight work within `SHUTDOWN_TIMEOUT_MS`.
- **CI** (`.github/workflows/ci.yml`) runs typecheck, build and the unit, route, integration, concurrency, end-to-end and realtime tests on every push and pull request.

## Environment Variables

All runtime configuration lives in the App Platform app settings (**Settings → App-Level / Component Environment Variables**), not in the repository. `.env.example` lists every variable the app reads; local development copies it to `.env`.

Set these before the first deploy:

- `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `JWT_LOGIN_CHALLENGE_SECRET`, `REFRESH_TOKEN_HASH_SECRET` — generate each separately: `openssl rand -base64 32`
- `DATABASE_URL` — the managed cluster's connection string with `?sslmode=require`
- `DATABASE_CA_CERT` — the cluster's CA certificate (PEM; download it from the cluster's **Connection Details**, or bind `${<db-component>.CA_CERT}`). Without it node-pg rejects the certificate with `self-signed certificate in certificate chain`
- `REDIS_URL` — the managed Redis connection string
- `CORS_ORIGIN` — the real frontend origin(s), not `*`
- `SPACES_ENDPOINT`, `SPACES_REGION`, `SPACES_ACCESS_KEY`, `SPACES_SECRET_KEY` — from the DigitalOcean control panel (API → Spaces Keys). Optional: the app starts without them; admin image upload returns 503 and worker images wait in the DB until they are set
- `SPACES_BUCKET` — a public-read Spaces bucket shared by profile images: `admin-images/{AdminCode}` and `worker-images/{WorkerCode}`, overwritten by name on a new image (the stored URL carries `?v=<hash>` so clients reload it). After setting these, redeploy (the app uploads pending worker images on startup) or run `npm run images:sync:prod` from the app console, then `npm run images:check:prod -- --verify` to confirm nothing is missing
- `LINE_CHANNEL_ACCESS_TOKEN`, `LINE_CHANNEL_SECRET` — from the LINE Developers console
- `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` — from the Firebase service account JSON
- `SENTRY_DSN` — optional; leave empty to keep Sentry disabled

Changing an environment variable triggers a redeploy.

## Database Backups

PostgreSQL runs on a DigitalOcean Managed Database cluster. Backups are handled by DigitalOcean — automatic daily backups with point-in-time recovery (7-day retention by default, extendable under the cluster's **Backups & Restore** tab). There is no backup script or cron job in this repo.

## Logging & Error Tracking

Three records, each with its own job — use `TicketNumber` / `TicketNo` (and `requestId`) to move between them when investigating a case:

| Record | For | Purpose | Retention |
| --- | --- | --- | --- |
| Audit log (`admin_action_logs`, `gate_request_logs`) | Admin | Who did what to which vehicle/ticket, when and why. Searchable by TicketNumber/TicketNo/BoothCode/WorkerCode via `search` on the admin audit API | Permanent (DB) |
| Server log (pino JSON on stdout) | Dev | Full detail of every request and failure, to trace a bug step by step | Log platform retention |
| Sentry | Dev | Alert on unexpected errors (5xx, unhandled rejections, failed background work) without waiting for a user report | Sentry plan |

Which number to search: `TicketNo` for a problem on one ticket/booth (booth products, Gate edit, worker submission, vendor confirm/LINE, ticket financials); `TicketNumber` for the whole vehicle (dispatch, worker accept/scan/removal, driver, vehicle cancel/release). Every log that knows a `TicketNo` also carries its `TicketNumber`, so start from `TicketNo` when unsure, then search the `TicketNumber` to see the whole vehicle. Vehicle-level events (dispatch, accept timeout) only carry `TicketNumber`. `BoothCode` repeats across tickets — always pair it with `TicketNo`.

Every request is logged once it completes, as a single structured JSON line to stdout (via [pino](https://getpino.io)) — never to a local file; App Platform collects stdout as the app's runtime logs. Fields logged per request:

- `requestId` — from the inbound `X-Request-Id` header, or a generated UUID if not sent. Always echoed back in the `X-Request-Id` response header, and included in every error response body so a user can report an issue and the team can find the matching log line fast.
- `method`, `path`, `statusCode`, `durationMs`
- `clientType` — `worker_app` / `admin_webapp` / `driver_webapp` / `gate` / `line_oa` / `unknown`, detected from the URL path prefix first, then (for the shared `/api/auth` routes only) from the authenticated account's role, then from an `X-Client-Type` header, then `unknown` — see `src/utils/client-type.ts`
- `clientVersion` — from an optional `X-Client-Version` header
- `userId` — the authenticated account id, when present
- `ip`
- `errorCode` — the API error code of a failed request (e.g. `TICKET_NO_ALREADY_EXISTS`), so 4xx cases are searchable by code
- `errorDetails` — the same details returned to the client on a 4xx (e.g. `ExistingTicketNumber`); for a database constraint rejection (`DUPLICATE_ENTRY` etc.) the Prisma code and constraint meta instead, so the violated constraint is known
- `body` — only for a Gate request rejected with 4xx (`gate_request_logs` stores accepted Gate requests only, so this is the one record of what Gate sent); 5xx bodies are in `Request failed.`
- `ticketNumber`, `ticketNo` / `ticketNos`, `ticketJobId`, `boothJobId`, `boothCode`, `workerCode` — whichever the request touched (from the path, the Gate/Admin/Worker body, the driver session, the LINE action token, or the looked-up ticket)

**Log context** (`src/utils/log-context.ts`): each request (and each background job) runs in its own AsyncLocalStorage context. Middleware and services add the ticket references with `setLogContext()` as soon as they know them, and every `logger.*` call during that request/job includes them automatically — no need to pass them by hand. Background jobs carry `jobName` / `jobId`; dispatch over several vehicles, sweep items and LINE webhook events use `runWithChildLogContext()` so each vehicle/event gets its own references (switching vehicle drops the previous vehicle's `ticketNo`).

Connections that live outside a single request log their own references: the Driver SSE stream logs the vehicle's `ticketNumber`, and the Worker WebSocket logs `workerCode` on connect (`Worker socket connected.`), on disconnect after the grace period (`Worker socket disconnected.`), on a server-side disconnect with its reason, and on a rejected upgrade (`Worker socket upgrade rejected.` with `errorCode`, since upgrades never reach the request log).

Log level follows the response status code: `>=500` → `error`, `>=400` → `warn`, otherwise → `info`.

**Sensitive data**: passwords, tokens, secrets, and `Authorization` headers are redacted (`[REDACTED]`) before anything is logged, via `src/utils/logger.ts`'s `redact()` — this applies to every `logger.*` call in the codebase, including the 5xx error log's request body, so this never needs to be handled per-endpoint.

**5xx errors** additionally log full context (`requestId`, `path`, `userId`, `clientType`, the redacted request body, stack trace).

**Sentry**: every `logger.error` call is reported to [Sentry](https://sentry.io) — 5xx requests (`Request failed.`), unhandled rejections, and failed background work (vendor LINE notification, dispatch, financialization, queue jobs). Tags: `requestId`, `ticket_number`, `ticket_no`, `ticket_job_id`, `booth_code`, `worker_code`, `job_name`, `client_type`, `path`, `alert_code` — search Sentry with e.g. `ticket_number:25691019000001`. The request body is never sent to Sentry. The same error (log message + error type) is sent at most 5 times per minute to protect the Sentry quota; the next event carries `suppressedInPreviousWindow`, and the server log still has every occurrence. `unhandledRejection` and `uncaughtException` are handled in `index.ts` through `logger.error` (Sentry's own handlers for them are disabled so each is reported once, with ticket tags); an uncaught exception flushes Sentry and exits the process. 4xx responses caused by user input and expected connection noise (SSE write after the client closed) are `warn` and stay in the server log only (system-fault 4xx are listed below). Sentry is a no-op until `SENTRY_DSN` is set.

**Viewing logs**: App Platform → the app → **Runtime Logs** (or `doctl apps logs <app-id> --type run --follow`). Every line is a JSON object; filter/search by any field above (e.g. `requestId` from an error response, `ticketNumber` / `ticketNo` from a reported case, or `errorCode`).

**LINE message quota**: an hourly job checks the LINE OA monthly message quota and reports to Sentry before it runs out. A push that fails because the quota is exhausted is not retried and is reported as its own issue.

| `alert_code` | Sentry issue | When |
| --- | --- | --- |
| `LINE_QUOTA_LOW` | `LINE monthly message quota is running low.` | usage ≥ 80% (extra: `used`, `limit`, `percent`) |
| `LINE_QUOTA_CRITICAL` | `LINE monthly message quota is nearly exhausted.` | usage ≥ 95% |
| `LINE_QUOTA_EXHAUSTED` | `LINE monthly message quota exhausted.` | LINE push returned 429 monthly limit |

Resolve the issue after topping up the quota so the next occurrence alerts again as a regression.

**System-fault alerts outside 5xx**: these are not caused by an admin, worker or driver input, so they are reported to Sentry with an `alert_code` even though the response is 4xx or the request has not finished.

| `alert_code` | Sentry issue | Meaning |
| --- | --- | --- |
| `SLOW_REQUEST` | `Request is taking too long.` | A request has not responded after 15 seconds (SSE streams and multipart uploads are skipped) |
| `MARKET_NAME_NOT_CONFIGURED` | `Request rejected because of missing configuration: MARKET_NAME_NOT_CONFIGURED.` | Master market has no name, so the Gate request is rejected (409) |
| `BOOTH_VENDOR_LINE_NOT_CONFIGURED` | `Request rejected because of missing configuration: BOOTH_VENDOR_LINE_NOT_CONFIGURED.` / `Skipped reconciling orphaned ticket submission: no vendor LINE target configured.` | Booth has no vendor LINE target, so the Gate request is rejected or a delivered ticket cannot be sent to the vendor |
| `LINE_SIGNATURE_MISMATCH` | `LINE webhook signature mismatch. Check LINE_CHANNEL_SECRET.` | LINE webhooks are signed but do not match — `LINE_CHANNEL_SECRET` is wrong |
| `GATE_CREDENTIALS_REJECTED` | `Gate client credentials were rejected.` | Gate sent well-formed Basic credentials that do not match an active Gate client (extra: `gateClientId`) |
| `GATE_TRANSACTION_REF_PAYLOAD_MISMATCH` | `Gate request payload mismatch` | Gate reused a `gate_transaction_ref` with a different payload |

**Configuring Sentry**: set `SENTRY_DSN` in the App Platform environment variables — a no-op until set.

Logs are raw JSON lines in every environment, including local development.
