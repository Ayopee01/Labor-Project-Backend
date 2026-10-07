-- Refactor: Worker moves out of accounts/user_sessions entirely into a dedicated MasterWorker
-- master-data table synced from the external Master DB (see docs/worker.md, docs/worker.csv).
-- accounts/user_sessions now serve Admin/back-office identity only.
--
-- IMPORTANT — this migration assumes the worker-linked business tables below are currently EMPTY
-- in this environment (fresh dev DB, no docker container running at the time this was written).
-- It does NOT backfill worker_account_id/account_id values into the new worker_id columns, because
-- there is no reliable mapping from the old accounts.id space to the new master_workers.id space
-- (master_workers rows do not exist until `prisma db seed` runs). If this is ever run against a
-- database that already has real vehicle_job_assignments / worker_assignment_events / ticket_workers
-- / worker_shift_attendances / worker_notifications / worker_push_tokens / ticket_completion_submissions
-- rows, this migration will fail (NOT NULL violations) or silently misassign worker identity — write
-- a proper data-backfill step first in that case.

-- ============================================================================
-- 1. MasterWorker + WorkerSession (new tables)
-- ============================================================================

CREATE TABLE "master_workers" (
    "id" SERIAL NOT NULL,
    "labor_id" INTEGER,
    "labor_code" VARCHAR(50) NOT NULL,
    "prefix" VARCHAR(20),
    "name" VARCHAR(255),
    "full_name" VARCHAR(255),
    "labor_status" VARCHAR(50),
    "status" INTEGER,
    "work_code" INTEGER,
    "nationality" VARCHAR(100),
    "telephone" VARCHAR(50),
    "work_start_date" DATE,
    "labor_color" VARCHAR(50),
    "labor_coat" VARCHAR(50),
    "coat_no" VARCHAR(50),
    "time_work" VARCHAR(50),
    "time_in" CHAR(5),
    "time_out" CHAR(5),
    "picture" BYTEA,
    "update_date" TIMESTAMP(3),
    "shift_no" INTEGER,
    "shift_start_time" CHAR(5),
    "shift_end_time" CHAR(5),
    "lang" VARCHAR(10) NOT NULL DEFAULT 'TH',
    "source" VARCHAR(30) NOT NULL DEFAULT 'master_sync',
    "password_hash" VARCHAR(512),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "master_workers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "master_workers_labor_id_key" ON "master_workers"("labor_id");
CREATE UNIQUE INDEX "master_workers_labor_code_key" ON "master_workers"("labor_code");
CREATE INDEX "master_workers_status_idx" ON "master_workers"("status");
CREATE INDEX "master_workers_source_idx" ON "master_workers"("source");

CREATE TABLE "worker_sessions" (
    "id" SERIAL NOT NULL,
    "worker_id" INTEGER NOT NULL,
    "refresh_token_hash" VARCHAR(512) NOT NULL,
    "device_id" VARCHAR(255) NOT NULL,
    "device_name" VARCHAR(255) NOT NULL,
    "ip_address" VARCHAR(64),
    "user_agent" VARCHAR(512),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_active_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worker_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "worker_sessions_worker_id_is_active_idx" ON "worker_sessions"("worker_id", "is_active");

ALTER TABLE "worker_sessions" ADD CONSTRAINT "worker_sessions_worker_id_fkey"
  FOREIGN KEY ("worker_id") REFERENCES "master_workers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ============================================================================
-- 2. worker_push_tokens: add worker_id FK, repoint session FK to worker_sessions
-- ============================================================================

ALTER TABLE "worker_push_tokens" ADD COLUMN "worker_id" INTEGER;
-- No reliable backfill source (see header note) — assumes table is empty in this environment.
ALTER TABLE "worker_push_tokens" ALTER COLUMN "worker_id" SET NOT NULL;

ALTER TABLE "worker_push_tokens" DROP CONSTRAINT IF EXISTS "worker_push_tokens_session_id_fkey";
DROP INDEX IF EXISTS "worker_push_tokens_worker_code_device_id_platform_key";
DROP INDEX IF EXISTS "worker_push_tokens_worker_code_is_active_idx";

CREATE UNIQUE INDEX "worker_push_tokens_worker_id_device_id_platform_key" ON "worker_push_tokens"("worker_id", "device_id", "platform");
CREATE INDEX "worker_push_tokens_worker_id_is_active_idx" ON "worker_push_tokens"("worker_id", "is_active");

ALTER TABLE "worker_push_tokens" ADD CONSTRAINT "worker_push_tokens_worker_id_fkey"
  FOREIGN KEY ("worker_id") REFERENCES "master_workers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "worker_push_tokens" ADD CONSTRAINT "worker_push_tokens_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "worker_sessions"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- ============================================================================
-- 3. worker_notifications: worker_account_id -> worker_id (accounts -> master_workers)
-- ============================================================================

ALTER TABLE "worker_notifications" DROP CONSTRAINT IF EXISTS "worker_notifications_worker_account_id_fkey";
ALTER TABLE "worker_notifications" RENAME COLUMN "worker_account_id" TO "worker_id";

DROP INDEX IF EXISTS "worker_notifications_worker_account_id_created_at_idx";
DROP INDEX IF EXISTS "worker_notifications_worker_account_id_read_at_idx";

CREATE INDEX "worker_notifications_worker_id_created_at_idx" ON "worker_notifications"("worker_id", "created_at");
CREATE INDEX "worker_notifications_worker_id_read_at_idx" ON "worker_notifications"("worker_id", "read_at");

ALTER TABLE "worker_notifications" ADD CONSTRAINT "worker_notifications_worker_id_fkey"
  FOREIGN KEY ("worker_id") REFERENCES "master_workers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ============================================================================
-- 4. worker_shift_attendances: account_id -> worker_id (accounts -> master_workers)
-- ============================================================================

ALTER TABLE "worker_shift_attendances" DROP CONSTRAINT IF EXISTS "worker_shift_attendances_account_id_fkey";
ALTER TABLE "worker_shift_attendances" RENAME COLUMN "account_id" TO "worker_id";

DROP INDEX IF EXISTS "worker_shift_attendances_account_id_shift_instance_key_key";
CREATE UNIQUE INDEX "worker_shift_attendances_worker_id_shift_instance_key_key" ON "worker_shift_attendances"("worker_id", "shift_instance_key");

ALTER TABLE "worker_shift_attendances" ADD CONSTRAINT "worker_shift_attendances_worker_id_fkey"
  FOREIGN KEY ("worker_id") REFERENCES "master_workers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ============================================================================
-- 5. ticket_workers: worker_account_id -> worker_id (accounts -> master_workers)
-- ============================================================================

ALTER TABLE "ticket_workers" DROP CONSTRAINT IF EXISTS "ticket_workers_worker_account_id_fkey";
ALTER TABLE "ticket_workers" RENAME COLUMN "worker_account_id" TO "worker_id";

DROP INDEX IF EXISTS "ticket_workers_worker_account_id_status_idx";
DROP INDEX IF EXISTS "ticket_workers_market_job_id_worker_account_id_key";

CREATE INDEX "ticket_workers_worker_id_status_idx" ON "ticket_workers"("worker_id", "status");
CREATE UNIQUE INDEX "ticket_workers_market_job_id_worker_id_key" ON "ticket_workers"("market_job_id", "worker_id");

ALTER TABLE "ticket_workers" ADD CONSTRAINT "ticket_workers_worker_id_fkey"
  FOREIGN KEY ("worker_id") REFERENCES "master_workers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ============================================================================
-- 6. vehicle_job_assignments: worker_account_id -> worker_id (accounts -> master_workers)
-- ============================================================================

ALTER TABLE "vehicle_job_assignments" DROP CONSTRAINT IF EXISTS "vehicle_job_assignments_worker_account_id_fkey";
ALTER TABLE "vehicle_job_assignments" RENAME COLUMN "worker_account_id" TO "worker_id";

DROP INDEX IF EXISTS "vehicle_job_assignments_worker_account_id_status_idx";
CREATE INDEX "vehicle_job_assignments_worker_id_status_idx" ON "vehicle_job_assignments"("worker_id", "status");

ALTER TABLE "vehicle_job_assignments" ADD CONSTRAINT "vehicle_job_assignments_worker_id_fkey"
  FOREIGN KEY ("worker_id") REFERENCES "master_workers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ============================================================================
-- 7. worker_assignment_events: worker_account_id -> worker_id (accounts -> master_workers)
-- ============================================================================

ALTER TABLE "worker_assignment_events" DROP CONSTRAINT IF EXISTS "worker_assignment_events_worker_account_id_fkey";
ALTER TABLE "worker_assignment_events" RENAME COLUMN "worker_account_id" TO "worker_id";

DROP INDEX IF EXISTS "worker_assignment_events_worker_account_id_occurred_at_idx";
DROP INDEX IF EXISTS "worker_assignment_events_worker_account_id_event_type_occurred_at_idx";

CREATE INDEX "worker_assignment_events_worker_id_occurred_at_idx" ON "worker_assignment_events"("worker_id", "occurred_at");
CREATE INDEX "worker_assignment_events_worker_id_event_type_occurred_at_idx" ON "worker_assignment_events"("worker_id", "event_type", "occurred_at");

ALTER TABLE "worker_assignment_events" ADD CONSTRAINT "worker_assignment_events_worker_id_fkey"
  FOREIGN KEY ("worker_id") REFERENCES "master_workers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ============================================================================
-- 8. ticket_completion_submissions: split submitter into admin FK / worker FK
-- ============================================================================

ALTER TABLE "ticket_completion_submissions" DROP CONSTRAINT IF EXISTS "ticket_completion_submissions_submitted_by_worker_account__fkey";
ALTER TABLE "ticket_completion_submissions" ALTER COLUMN "submitted_by_account_id" DROP NOT NULL;
ALTER TABLE "ticket_completion_submissions" ADD COLUMN "submitted_by_worker_id" INTEGER;

-- Historical rows before this migration were always worker self-submissions (see
-- 20260825090000_ticket_completion_submission_submitter_role) — move that identity across so the
-- new worker FK is the one enforced going forward. Rows will only resolve correctly once the
-- referenced master_workers row exists for that historical worker; if this table already has real
-- data when this migration runs, review this backfill before trusting it (see header note).
UPDATE "ticket_completion_submissions"
SET "submitted_by_worker_id" = "submitted_by_account_id",
    "submitted_by_account_id" = NULL
WHERE "submitted_by_role" = 'worker';

ALTER TABLE "ticket_completion_submissions" ADD CONSTRAINT "ticket_completion_submissions_submitted_by_account_id_fkey"
  FOREIGN KEY ("submitted_by_account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "ticket_completion_submissions" ADD CONSTRAINT "ticket_completion_submissions_submitted_by_worker_id_fkey"
  FOREIGN KEY ("submitted_by_worker_id") REFERENCES "master_workers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "ticket_completion_submissions" ADD CONSTRAINT "ticket_completion_submissions_submitter_role_check"
  CHECK (
    ("submitted_by_role" = 'admin' AND "submitted_by_account_id" IS NOT NULL AND "submitted_by_worker_id" IS NULL)
    OR
    ("submitted_by_role" = 'worker' AND "submitted_by_worker_id" IS NOT NULL AND "submitted_by_account_id" IS NULL)
  );

CREATE INDEX "ticket_completion_submissions_submitted_by_worker_id_idx" ON "ticket_completion_submissions"("submitted_by_worker_id");

-- ============================================================================
-- 9. accounts: drop worker-only fields (Account = Admin identity only from here on)
-- ============================================================================

DROP INDEX IF EXISTS "accounts_shirt_number_key";
DROP INDEX IF EXISTS "accounts_worker_phone_key";
DROP INDEX IF EXISTS "accounts_master_worker_id_key";
DROP INDEX IF EXISTS "accounts_role_source_idx";
DROP INDEX IF EXISTS "accounts_master_updated_at_idx";

ALTER TABLE "accounts"
  DROP COLUMN IF EXISTS "nationality",
  DROP COLUMN IF EXISTS "work_start_date",
  DROP COLUMN IF EXISTS "shirt_type",
  DROP COLUMN IF EXISTS "shirt_number",
  DROP COLUMN IF EXISTS "shift_no",
  DROP COLUMN IF EXISTS "shift_start_time",
  DROP COLUMN IF EXISTS "shift_end_time",
  DROP COLUMN IF EXISTS "source",
  DROP COLUMN IF EXISTS "master_worker_id",
  DROP COLUMN IF EXISTS "master_updated_at",
  DROP COLUMN IF EXISTS "synced_at";

CREATE INDEX "accounts_role_idx" ON "accounts"("role");
