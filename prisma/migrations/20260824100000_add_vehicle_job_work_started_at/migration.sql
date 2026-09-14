-- Set once, the first time a vehicle job's status becomes WORKING (whole team scanned in).
-- Nullable because existing rows and vehicle jobs that never reach WORKING never get a value.
ALTER TABLE "vehicle_jobs" ADD COLUMN "work_started_at" TIMESTAMP(3);
