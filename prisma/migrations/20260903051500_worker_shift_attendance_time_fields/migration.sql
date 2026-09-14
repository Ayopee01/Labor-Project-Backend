-- Replace shift_no/shift_start_time/shift_end_time on worker_shift_attendances with
-- time_work/time_in/time_out, mirroring the same rename already done on master_workers, converting
-- any existing rows (1 -> Morning, 2 -> Evening) rather than dropping them blind.
ALTER TABLE "worker_shift_attendances" ADD COLUMN "time_work" VARCHAR(50);

UPDATE "worker_shift_attendances"
SET "time_work" = CASE "shift_no"
  WHEN 1 THEN 'Morning'
  WHEN 2 THEN 'Evening'
  ELSE "time_work"
END;

ALTER TABLE "worker_shift_attendances" ALTER COLUMN "time_work" SET NOT NULL;
ALTER TABLE "worker_shift_attendances" DROP COLUMN "shift_no";

ALTER TABLE "worker_shift_attendances" RENAME COLUMN "shift_start_time" TO "time_in";
ALTER TABLE "worker_shift_attendances" RENAME COLUMN "shift_end_time" TO "time_out";
