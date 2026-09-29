-- TicketCompletionSubmission.workerCountSnapshot: count of WORKING TicketWorker rows at the exact
-- moment this submission was created. Nullable and intentionally never backfilled -- existing rows
-- created before this migration have no reliable historical worker count.
ALTER TABLE "ticket_completion_submissions" ADD COLUMN "worker_count_snapshot" INTEGER;
