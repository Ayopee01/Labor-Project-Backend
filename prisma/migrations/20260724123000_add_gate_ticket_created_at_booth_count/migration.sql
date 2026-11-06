ALTER TABLE "vehicle_jobs"
ADD COLUMN "ticket_created_at" TIMESTAMP(3);

UPDATE "vehicle_jobs"
SET "ticket_created_at" = "created_at"
WHERE "ticket_created_at" IS NULL;

ALTER TABLE "vehicle_jobs"
ALTER COLUMN "ticket_created_at" SET NOT NULL;

ALTER TABLE "vehicle_jobs"
ADD COLUMN "booth_count" INTEGER NOT NULL DEFAULT 1;
