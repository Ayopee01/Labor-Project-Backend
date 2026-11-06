UPDATE "vehicle_jobs"
SET "status" = 'WORKING'
WHERE "status" = 'IN_PROGRESS';

UPDATE "market_jobs"
SET "status" = 'WORKING'
WHERE "status" = 'IN_PROGRESS';

UPDATE "gate_tickets"
SET "status" = 'WORKING'
WHERE "status" = 'IN_PROGRESS';

UPDATE "ticket_workers"
SET "status" = 'WORKING'
WHERE "status" = 'IN_PROGRESS';

ALTER TABLE "ticket_workers"
ALTER COLUMN "status" SET DEFAULT 'WORKING';
