-- Gate ticket edit result (UPDATED / NO_CHANGE) stored explicitly so Work History Timeline can
-- skip NO_CHANGE requests, plus an index to batch-load the edits of the vehicles on one page.

ALTER TABLE "gate_request_logs" ADD COLUMN "result" VARCHAR(20);

-- Backfill: existing UPDATE rows already keep the response Result in response_snapshot
UPDATE "gate_request_logs"
SET "result" = "response_snapshot"->>'Result'
WHERE "request_type" = 'UPDATE'
  AND "response_snapshot"->>'Result' IN ('UPDATED', 'NO_CHANGE');

CREATE INDEX "gate_request_logs_ticket_job_id_created_at_idx" ON "gate_request_logs"("ticket_job_id", "created_at");
