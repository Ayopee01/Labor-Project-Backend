-- TicketNumber (VehicleJob) -> Ticket/Business Ticket (MarketJob) -> Booth (GateTicket) -> Product
--
-- One vehicle (VehicleJob, now identified by ticket_number) can own many Business Tickets
-- (MarketJob, now carrying its own ticket_no) created over separate Gate requests. Worker
-- roster membership (TicketWorker) moves from booth-level to Business-Ticket-level.
--
-- No destructive resets: every relocated/renamed column is backfilled from existing data
-- before old columns are dropped. Historical VehicleJob rows had exactly one MarketJob each
-- (old 1:1 assumption), so that MarketJob inherits the vehicle's old per-request fields.

-- ============================================================================
-- Step 1: vehicle_jobs.ticket_no -> ticket_number (rename, zero data loss)
-- ============================================================================
ALTER TABLE "vehicle_jobs" RENAME COLUMN "ticket_no" TO "ticket_number";
ALTER INDEX "vehicle_jobs_ticket_no_key" RENAME TO "vehicle_jobs_ticket_number_key";

-- New vehicle-level columns for the "Gate has no more Tickets coming" gate.
ALTER TABLE "vehicle_jobs" ADD COLUMN "expected_ticket_count" INTEGER;
ALTER TABLE "vehicle_jobs" ADD COLUMN "tickets_closed_at" TIMESTAMP(3);

-- ============================================================================
-- Step 2: market_jobs gains the Business Ticket identity + relocated fields
-- ============================================================================
ALTER TABLE "market_jobs" ADD COLUMN "ticket_no" VARCHAR(100);
ALTER TABLE "market_jobs" ADD COLUMN "ticket_created_at" TIMESTAMP(3);
ALTER TABLE "market_jobs" ADD COLUMN "booth_count" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "market_jobs" ADD COLUMN "gate_transaction_ref" VARCHAR(100);
ALTER TABLE "market_jobs" ADD COLUMN "workers_required" INTEGER;
ALTER TABLE "market_jobs" ADD COLUMN "worker_qr_token" VARCHAR(255);
ALTER TABLE "market_jobs" ADD COLUMN "worker_roster_locked_at" TIMESTAMP(3);
ALTER TABLE "market_jobs" ADD COLUMN "final_stall_amount" DECIMAL(18,2);
ALTER TABLE "market_jobs" ADD COLUMN "financialized_at" TIMESTAMP(3);
ALTER TABLE "market_jobs" ADD COLUMN "completed_at" TIMESTAMP(3);

-- Backfill from the parent vehicle's old per-request columns (still present at this point).
UPDATE "market_jobs" mj
SET
  "ticket_no" = vj."ticket_number",
  "ticket_created_at" = vj."ticket_created_at",
  "booth_count" = vj."booth_count",
  "gate_transaction_ref" = vj."gate_transaction_ref",
  "workers_required" = vj."workers_required"
FROM "vehicle_jobs" vj
WHERE mj."vehicle_job_id" = vj."id";

-- Opaque per-Ticket QR secret, generated with pure built-in SQL (no pgcrypto dependency)
-- so this migration stays a single automated `prisma migrate deploy` step. Historical/
-- already-closed-out tickets only need a non-guessable, unique value, not a
-- cryptographically-sourced one.
UPDATE "market_jobs"
SET "worker_qr_token" = 'wqr_' || md5(random()::text || clock_timestamp()::text || "id"::text)
WHERE "worker_qr_token" IS NULL;

ALTER TABLE "market_jobs" ALTER COLUMN "ticket_no" SET NOT NULL;
ALTER TABLE "market_jobs" ALTER COLUMN "ticket_created_at" SET NOT NULL;
ALTER TABLE "market_jobs" ALTER COLUMN "gate_transaction_ref" SET NOT NULL;
ALTER TABLE "market_jobs" ALTER COLUMN "workers_required" SET NOT NULL;
ALTER TABLE "market_jobs" ALTER COLUMN "worker_qr_token" SET NOT NULL;

-- Identity moves from (vehicle_job_id, market_code) to (vehicle_job_id, ticket_no):
-- a TicketNumber may now have two Tickets against the same market.
DROP INDEX "market_jobs_vehicle_job_id_market_code_key";
CREATE INDEX "market_jobs_vehicle_job_id_market_code_idx" ON "market_jobs"("vehicle_job_id", "market_code");
CREATE UNIQUE INDEX "market_jobs_vehicle_job_id_ticket_no_key" ON "market_jobs"("vehicle_job_id", "ticket_no");
CREATE UNIQUE INDEX "market_jobs_worker_qr_token_key" ON "market_jobs"("worker_qr_token");

-- ============================================================================
-- Step 3: ticket_workers repointed from booth (GateTicket) to Business Ticket (MarketJob)
-- ============================================================================
ALTER TABLE "ticket_workers" ADD COLUMN "market_job_id" INTEGER;

UPDATE "ticket_workers" tw
SET "market_job_id" = gt."market_job_id"
FROM "gate_tickets" gt
WHERE tw."ticket_id" = gt."id";

ALTER TABLE "ticket_workers" ALTER COLUMN "market_job_id" SET NOT NULL;

ALTER TABLE "ticket_workers" DROP CONSTRAINT "ticket_workers_ticket_id_fkey";
DROP INDEX "ticket_workers_ticket_id_status_idx";
DROP INDEX "ticket_workers_ticket_id_worker_account_id_key";
ALTER TABLE "ticket_workers" DROP COLUMN "ticket_id";

CREATE INDEX "ticket_workers_market_job_id_status_idx" ON "ticket_workers"("market_job_id", "status");
CREATE UNIQUE INDEX "ticket_workers_market_job_id_worker_account_id_key" ON "ticket_workers"("market_job_id", "worker_account_id");
ALTER TABLE "ticket_workers" ADD CONSTRAINT "ticket_workers_market_job_id_fkey"
  FOREIGN KEY ("market_job_id") REFERENCES "market_jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- ============================================================================
-- Step 4: audit-only FKs (both nullable, no backfill possible/needed for historical rows)
-- ============================================================================
ALTER TABLE "vehicle_job_assignments" ADD COLUMN "source_market_job_id" INTEGER;
ALTER TABLE "vehicle_job_assignments" ADD CONSTRAINT "vehicle_job_assignments_source_market_job_id_fkey"
  FOREIGN KEY ("source_market_job_id") REFERENCES "market_jobs"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "gate_request_logs" ADD COLUMN "market_job_id" INTEGER;
ALTER TABLE "gate_request_logs" ADD CONSTRAINT "gate_request_logs_market_job_id_fkey"
  FOREIGN KEY ("market_job_id") REFERENCES "market_jobs"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ============================================================================
-- Step 5: drop the now-relocated vehicle_jobs columns (fully backfilled into market_jobs above)
-- ============================================================================
ALTER TABLE "vehicle_jobs" DROP COLUMN "booth_count";
ALTER TABLE "vehicle_jobs" DROP COLUMN "gate_transaction_ref";
ALTER TABLE "vehicle_jobs" DROP COLUMN "ticket_created_at";
