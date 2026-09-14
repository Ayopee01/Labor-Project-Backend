-- Rename schedules to match their worker-only purpose.
ALTER TABLE "user_work_schedules" RENAME TO "worker_work_schedules";

ALTER INDEX IF EXISTS "user_work_schedules_pkey" RENAME TO "worker_work_schedules_pkey";
ALTER INDEX IF EXISTS "user_work_schedules_account_id_is_current_idx" RENAME TO "worker_work_schedules_account_id_is_current_idx";

ALTER TABLE "worker_work_schedules" RENAME CONSTRAINT "user_work_schedules_account_id_fkey" TO "worker_work_schedules_account_id_fkey";
ALTER TABLE "worker_work_schedules" RENAME CONSTRAINT "user_work_schedules_created_by_fkey" TO "worker_work_schedules_created_by_fkey";
ALTER TABLE "worker_work_schedules" RENAME CONSTRAINT "user_work_schedules_updated_by_fkey" TO "worker_work_schedules_updated_by_fkey";

-- Current worker schedules are limited to two shifts per worker.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "worker_work_schedules"
    WHERE "is_current" = true
    GROUP BY "account_id"
    HAVING COUNT(*) > 2
  ) THEN
    RAISE EXCEPTION 'Cannot add shift_no because at least one worker has more than 2 current schedules.';
  END IF;
END $$;

ALTER TABLE "worker_work_schedules" ADD COLUMN "shift_no" INTEGER;

WITH ranked AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "account_id", "is_current"
      ORDER BY "id" ASC
    ) AS next_shift_no
  FROM "worker_work_schedules"
)
UPDATE "worker_work_schedules" AS schedule
SET "shift_no" = CASE
  WHEN schedule."is_current" = true THEN ranked.next_shift_no
  ELSE 1
END
FROM ranked
WHERE schedule."id" = ranked."id";

ALTER TABLE "worker_work_schedules" ALTER COLUMN "shift_no" SET DEFAULT 1;
ALTER TABLE "worker_work_schedules" ALTER COLUMN "shift_no" SET NOT NULL;
ALTER TABLE "worker_work_schedules" ADD CONSTRAINT "worker_work_schedules_shift_no_check" CHECK ("shift_no" IN (1, 2));

CREATE UNIQUE INDEX "worker_work_schedules_current_shift_no_key"
ON "worker_work_schedules" ("account_id", "shift_no")
WHERE "is_current" = true;

-- Worker phone is now stored only in accounts, so prevent duplicate active identifiers.
CREATE UNIQUE INDEX "accounts_worker_phone_key"
ON "accounts" ("phone")
WHERE "role" = 'worker' AND "phone" IS NOT NULL;
