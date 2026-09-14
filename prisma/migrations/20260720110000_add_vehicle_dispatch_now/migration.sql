ALTER TABLE "vehicle_jobs"
ADD COLUMN "dispatch_now" BOOLEAN NOT NULL DEFAULT false;

UPDATE "vehicle_jobs" AS vehicle
SET "dispatch_now" = true
FROM "gate_request_logs" AS gate_log
WHERE gate_log."vehicle_job_id" = vehicle."id"
  AND gate_log."payload_snapshot" ? 'dispatch_now'
  AND (gate_log."payload_snapshot" ->> 'dispatch_now')::boolean = true;
