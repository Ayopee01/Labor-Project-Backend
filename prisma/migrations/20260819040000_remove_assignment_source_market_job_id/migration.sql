-- Remove VehicleJobAssignment.sourceMarketJobId: an audit-only field recording which
-- Business Ticket (if any) triggered a worker's dispatch. It was never used for access
-- control, never surfaced anywhere besides the worker's own accept response, and is not
-- populated at all for most dispatch triggers (driver ready, worker online, admin assign,
-- release-and-redispatch) — only when Gate creates a new Business Ticket. Removed as
-- unused rather than kept "just in case".

-- DropForeignKey
ALTER TABLE "vehicle_job_assignments" DROP CONSTRAINT "vehicle_job_assignments_source_market_job_id_fkey";

-- AlterTable
ALTER TABLE "vehicle_job_assignments" DROP COLUMN "source_market_job_id";
