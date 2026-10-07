-- Merge worker profile and current schedule data into accounts to reduce duplicate worker tables.
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "image_url" VARCHAR(512);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "nationality" VARCHAR(100);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "work_start_date" CHAR(10);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "shirt_type" VARCHAR(50);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "shirt_number" VARCHAR(50);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "shift_no" INTEGER;
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "shift_start_time" CHAR(5);
ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "shift_end_time" CHAR(5);

UPDATE "accounts" AS account
SET
  "image_url" = profile."image_url",
  "nationality" = profile."nationality",
  "work_start_date" = profile."work_start_date",
  "shirt_type" = profile."shirt_type",
  "shirt_number" = profile."shirt_number"
FROM "worker_profiles" AS profile
WHERE account."id" = profile."account_id";

WITH current_schedule AS (
  SELECT DISTINCT ON ("account_id")
    "account_id",
    "shift_no",
    "work_date",
    "shift_start_time",
    "shift_end_time"
  FROM "worker_work_schedules"
  WHERE "is_current" = TRUE
  ORDER BY "account_id", "shift_no" ASC, "id" ASC
)
UPDATE "accounts" AS account
SET
  "work_start_date" = COALESCE(account."work_start_date", current_schedule."work_date"),
  "shift_no" = current_schedule."shift_no",
  "shift_start_time" = current_schedule."shift_start_time",
  "shift_end_time" = current_schedule."shift_end_time"
FROM current_schedule
WHERE account."id" = current_schedule."account_id";

DROP INDEX IF EXISTS "worker_profiles_shirt_number_key";
DROP INDEX IF EXISTS "worker_profiles_account_id_key";
DROP TABLE IF EXISTS "worker_profiles";

DROP INDEX IF EXISTS "worker_work_schedules_current_shift_no_key";
DROP INDEX IF EXISTS "worker_work_schedules_account_id_is_current_idx";
DROP TABLE IF EXISTS "worker_work_schedules";

CREATE UNIQUE INDEX IF NOT EXISTS "accounts_shirt_number_key" ON "accounts" ("shirt_number");

DROP INDEX IF EXISTS "vehicle_jobs_worker_qr_token_key";
ALTER TABLE "vehicle_jobs" DROP COLUMN IF EXISTS "worker_qr_token";

ALTER TABLE "gate_tickets" DROP COLUMN IF EXISTS "confirmation_status";
