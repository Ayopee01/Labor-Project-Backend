-- Remove MarketJob.workerQrToken: an opaque per-Business-Ticket secret generated at Gate
-- Create for worker check-in. Replaced by scanning the Business Ticket's own ticket_no
-- (the barcode already printed on the physical Gate paper ticket, which the worker actually
-- has in hand) instead of a system-generated secret the worker never sees on paper. The new
-- check-in-barcode flow resolves the Business Ticket by [vehicle_job_id, ticket_no], which is
-- already scoped to the worker's own vehicle (found via the TicketNumber path param + auth),
-- so ticket_no does not need to be a separate globally-unique secret.

-- DropIndex
DROP INDEX "market_jobs_worker_qr_token_key";

-- AlterTable
ALTER TABLE "market_jobs" DROP COLUMN "worker_qr_token";
