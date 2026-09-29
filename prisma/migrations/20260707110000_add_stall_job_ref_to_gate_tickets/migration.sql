-- Add stall job reference as the workflow key for stall-level jobs.
ALTER TABLE "gate_tickets" ADD COLUMN "stall_job_ref" VARCHAR(100);

-- Backfill existing development data from ticket_no so the new key can be required.
UPDATE "gate_tickets"
SET "stall_job_ref" = "ticket_no"
WHERE "stall_job_ref" IS NULL;

ALTER TABLE "gate_tickets" ALTER COLUMN "stall_job_ref" SET NOT NULL;

-- ticket_no is now an optional external bill/document number.
ALTER TABLE "gate_tickets" ALTER COLUMN "ticket_no" DROP NOT NULL;

DROP INDEX IF EXISTS "gate_tickets_vehicle_job_id_ticket_no_key";

CREATE UNIQUE INDEX "gate_tickets_market_job_id_stall_job_ref_key"
ON "gate_tickets"("market_job_id", "stall_job_ref");

CREATE INDEX "gate_tickets_ticket_no_idx"
ON "gate_tickets"("ticket_no");
