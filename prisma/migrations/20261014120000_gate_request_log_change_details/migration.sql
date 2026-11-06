-- Compact diff of what a Gate ticket edit changed, computed during PUT so Work History can show it
-- without diffing snapshots on read. NULL = legacy row not backfilled yet.

ALTER TABLE "gate_request_logs" ADD COLUMN "change_details" JSONB;
