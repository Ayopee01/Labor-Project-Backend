ALTER TABLE "market_jobs"
ADD COLUMN "dropoff_point" VARCHAR(255);

ALTER TABLE "gate_tickets"
ADD COLUMN "reject_reason" TEXT;
