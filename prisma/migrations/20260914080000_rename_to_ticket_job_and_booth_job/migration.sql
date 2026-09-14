-- Rename: vehicle_jobs -> ticket_jobs, gate_tickets -> booth_jobs, vehicle_job_assignments ->
-- ticket_job_assignments, gate_ticket_worker_exclusions -> booth_job_worker_exclusions, and every
-- vehicle_job_id / gate_ticket_id FK column across the schema that points at them, per explicit user
-- decision (clearer naming that matches how the concept is already called "ticket"/"booth" elsewhere
-- in the codebase and docs). Every statement below is a RENAME (table/column/constraint/index/sequence)
-- — nothing is dropped, recreated, or backfilled, so all existing data and referential integrity is
-- preserved exactly. Renaming a table or column in Postgres does not invalidate FK constraints (they
-- are tracked internally by OID, not by name), so no FK needs to be dropped and recreated here.
--
-- Public API surface (route paths, request/response JSON field names) is intentionally NOT touched —
-- this migration only renames internal DB/Prisma-level identifiers.

-- ============================================================================
-- 1. Rename the 4 tables themselves + their own constraints/indexes/sequences
-- ============================================================================

ALTER TABLE "vehicle_jobs" RENAME TO "ticket_jobs";
ALTER TABLE "ticket_jobs" RENAME CONSTRAINT "vehicle_jobs_pkey" TO "ticket_jobs_pkey";
ALTER INDEX "vehicle_jobs_driver_qr_token_key" RENAME TO "ticket_jobs_driver_qr_token_key";
ALTER INDEX "vehicle_jobs_status_idx" RENAME TO "ticket_jobs_status_idx";
ALTER INDEX "vehicle_jobs_ticket_number_key" RENAME TO "ticket_jobs_ticket_number_key";
ALTER SEQUENCE "vehicle_jobs_id_seq" RENAME TO "ticket_jobs_id_seq";

ALTER TABLE "gate_tickets" RENAME TO "booth_jobs";
ALTER TABLE "booth_jobs" RENAME CONSTRAINT "gate_tickets_pkey" TO "booth_jobs_pkey";
ALTER TABLE "booth_jobs" RENAME CONSTRAINT "gate_tickets_market_job_id_fkey" TO "booth_jobs_market_job_id_fkey";
ALTER INDEX "gate_tickets_market_job_id_booth_code_key" RENAME TO "booth_jobs_market_job_id_booth_code_key";
ALTER INDEX "gate_tickets_market_job_id_status_idx" RENAME TO "booth_jobs_market_job_id_status_idx";
ALTER SEQUENCE "gate_tickets_id_seq" RENAME TO "booth_jobs_id_seq";

ALTER TABLE "vehicle_job_assignments" RENAME TO "ticket_job_assignments";
ALTER TABLE "ticket_job_assignments" RENAME CONSTRAINT "vehicle_job_assignments_pkey" TO "ticket_job_assignments_pkey";
ALTER TABLE "ticket_job_assignments" RENAME CONSTRAINT "vehicle_job_assignments_worker_id_fkey" TO "ticket_job_assignments_worker_id_fkey";
ALTER INDEX "vehicle_job_assignments_worker_id_status_idx" RENAME TO "ticket_job_assignments_worker_id_status_idx";
ALTER SEQUENCE "vehicle_job_assignments_id_seq" RENAME TO "ticket_job_assignments_id_seq";

ALTER TABLE "gate_ticket_worker_exclusions" RENAME TO "booth_job_worker_exclusions";
ALTER TABLE "booth_job_worker_exclusions" RENAME CONSTRAINT "gate_ticket_worker_exclusions_pkey" TO "booth_job_worker_exclusions_pkey";
ALTER TABLE "booth_job_worker_exclusions" RENAME CONSTRAINT "gate_ticket_worker_exclusions_ticket_worker_id_fkey" TO "booth_job_worker_exclusions_ticket_worker_id_fkey";
ALTER INDEX "gate_ticket_worker_exclusions_ticket_worker_id_idx" RENAME TO "booth_job_worker_exclusions_ticket_worker_id_idx";
ALTER SEQUENCE "gate_ticket_worker_exclusions_id_seq" RENAME TO "booth_job_worker_exclusions_id_seq";

-- ============================================================================
-- 2. booth_jobs (formerly gate_tickets): its own vehicle_job_id column -> ticket_job_id
-- ============================================================================

ALTER TABLE "booth_jobs" RENAME COLUMN "vehicle_job_id" TO "ticket_job_id";
ALTER TABLE "booth_jobs" RENAME CONSTRAINT "gate_tickets_vehicle_job_id_fkey" TO "booth_jobs_ticket_job_id_fkey";

-- ============================================================================
-- 3. ticket_job_assignments (formerly vehicle_job_assignments): its own vehicle_job_id -> ticket_job_id
-- ============================================================================

ALTER TABLE "ticket_job_assignments" RENAME COLUMN "vehicle_job_id" TO "ticket_job_id";
ALTER TABLE "ticket_job_assignments" RENAME CONSTRAINT "vehicle_job_assignments_vehicle_job_id_fkey" TO "ticket_job_assignments_ticket_job_id_fkey";
ALTER INDEX "vehicle_job_assignments_vehicle_job_id_status_idx" RENAME TO "ticket_job_assignments_ticket_job_id_status_idx";

-- ============================================================================
-- 4. booth_job_worker_exclusions (formerly gate_ticket_worker_exclusions): gate_ticket_id -> booth_job_id
-- ============================================================================

ALTER TABLE "booth_job_worker_exclusions" RENAME COLUMN "gate_ticket_id" TO "booth_job_id";
ALTER TABLE "booth_job_worker_exclusions" RENAME CONSTRAINT "gate_ticket_worker_exclusions_gate_ticket_id_fkey" TO "booth_job_worker_exclusions_booth_job_id_fkey";
ALTER INDEX "gate_ticket_worker_exclusions_gate_ticket_id_ticket_worker__key" RENAME TO "booth_job_worker_exclusions_booth_job_id_ticket_worker_id_key";

-- ============================================================================
-- 5. market_jobs.vehicle_job_id -> ticket_job_id
-- ============================================================================

ALTER TABLE "market_jobs" RENAME COLUMN "vehicle_job_id" TO "ticket_job_id";
ALTER TABLE "market_jobs" RENAME CONSTRAINT "market_jobs_vehicle_job_id_fkey" TO "market_jobs_ticket_job_id_fkey";
ALTER INDEX "market_jobs_vehicle_job_id_market_code_idx" RENAME TO "market_jobs_ticket_job_id_market_code_idx";
ALTER INDEX "market_jobs_vehicle_job_id_status_idx" RENAME TO "market_jobs_ticket_job_id_status_idx";
ALTER INDEX "market_jobs_vehicle_job_id_ticket_no_active_key" RENAME TO "market_jobs_ticket_job_id_ticket_no_active_key";
ALTER INDEX "market_jobs_vehicle_job_id_ticket_no_idx" RENAME TO "market_jobs_ticket_job_id_ticket_no_idx";

-- ============================================================================
-- 6. driver_sessions.vehicle_job_id -> ticket_job_id
-- ============================================================================

ALTER TABLE "driver_sessions" RENAME COLUMN "vehicle_job_id" TO "ticket_job_id";
ALTER TABLE "driver_sessions" RENAME CONSTRAINT "driver_sessions_vehicle_job_id_fkey" TO "driver_sessions_ticket_job_id_fkey";
ALTER INDEX "driver_sessions_vehicle_job_id_idx" RENAME TO "driver_sessions_ticket_job_id_idx";

-- ============================================================================
-- 7. gate_request_logs.vehicle_job_id -> ticket_job_id
-- ============================================================================

ALTER TABLE "gate_request_logs" RENAME COLUMN "vehicle_job_id" TO "ticket_job_id";
ALTER TABLE "gate_request_logs" RENAME CONSTRAINT "gate_request_logs_vehicle_job_id_fkey" TO "gate_request_logs_ticket_job_id_fkey";

-- ============================================================================
-- 8. worker_assignment_events.vehicle_job_id -> ticket_job_id
-- ============================================================================

ALTER TABLE "worker_assignment_events" RENAME COLUMN "vehicle_job_id" TO "ticket_job_id";
ALTER TABLE "worker_assignment_events" RENAME CONSTRAINT "worker_assignment_events_vehicle_job_id_fkey" TO "worker_assignment_events_ticket_job_id_fkey";
ALTER INDEX "worker_assignment_events_vehicle_job_id_idx" RENAME TO "worker_assignment_events_ticket_job_id_idx";

-- ============================================================================
-- 9. admin_action_logs.vehicle_job_id -> ticket_job_id, gate_ticket_id -> booth_job_id
-- ============================================================================

ALTER TABLE "admin_action_logs" RENAME COLUMN "vehicle_job_id" TO "ticket_job_id";
ALTER TABLE "admin_action_logs" RENAME CONSTRAINT "admin_action_logs_vehicle_job_id_fkey" TO "admin_action_logs_ticket_job_id_fkey";
ALTER INDEX "admin_action_logs_vehicle_job_id_created_at_idx" RENAME TO "admin_action_logs_ticket_job_id_created_at_idx";

ALTER TABLE "admin_action_logs" RENAME COLUMN "gate_ticket_id" TO "booth_job_id";
ALTER TABLE "admin_action_logs" RENAME CONSTRAINT "admin_action_logs_gate_ticket_id_fkey" TO "admin_action_logs_booth_job_id_fkey";
ALTER INDEX "admin_action_logs_gate_ticket_id_created_at_idx" RENAME TO "admin_action_logs_booth_job_id_created_at_idx";

-- ============================================================================
-- 10. worker_snapshots.gate_ticket_id -> booth_job_id
-- ============================================================================

ALTER TABLE "worker_snapshots" RENAME COLUMN "gate_ticket_id" TO "booth_job_id";
ALTER TABLE "worker_snapshots" RENAME CONSTRAINT "worker_snapshots_gate_ticket_id_fkey" TO "worker_snapshots_booth_job_id_fkey";
ALTER INDEX "worker_snapshots_gate_ticket_id_ticket_worker_id_key" RENAME TO "worker_snapshots_booth_job_id_ticket_worker_id_key";
