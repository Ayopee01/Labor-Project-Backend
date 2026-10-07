-- Backfill time_work/time_in/time_out from the current operational shift_* values before dropping
-- them, so a worker whose shift was previously changed by an Admin (via PATCH .../users/:workerCode,
-- which only ever wrote shift_no/shift_start_time/shift_end_time, never time_work/time_in/time_out)
-- does not silently revert back to stale Master-sync data once shift_* is gone.
UPDATE "master_workers"
SET
  "time_work" = CASE "shift_no"
    WHEN 1 THEN 'Morning'
    WHEN 2 THEN 'Evening'
    ELSE "time_work"
  END,
  "time_in" = COALESCE("shift_start_time", "time_in"),
  "time_out" = COALESCE("shift_end_time", "time_out")
WHERE "shift_no" IS NOT NULL OR "shift_start_time" IS NOT NULL OR "shift_end_time" IS NOT NULL;

-- AlterTable
ALTER TABLE "master_workers" DROP COLUMN "shift_end_time",
DROP COLUMN "shift_no",
DROP COLUMN "shift_start_time";
