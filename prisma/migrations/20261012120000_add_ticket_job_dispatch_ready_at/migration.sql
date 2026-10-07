-- Track when a vehicle job last became dispatchable (status entered WORKING / Dispatch = true).
-- Worker dispatch serves vehicle jobs strictly in this order (oldest first) and waits until the
-- ready queue has enough workers for the job at the head before moving on (no skipping).
-- Cleared when the job leaves WORKING so re-opening dispatch puts the job at the back of the queue.

ALTER TABLE "ticket_jobs" ADD COLUMN "dispatch_ready_at" TIMESTAMP(3);

-- Backfill jobs that are already dispatchable using their creation time (keeps the previous id order)
UPDATE "ticket_jobs" SET "dispatch_ready_at" = "created_at" WHERE "status" = 'WORKING';

CREATE INDEX "ticket_jobs_status_dispatch_ready_at_idx" ON "ticket_jobs"("status", "dispatch_ready_at");
