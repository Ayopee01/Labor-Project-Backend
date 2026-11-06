-- admin_action_logs.vehicle_job_id becomes nullable: some admin actions (e.g. forcing a
-- worker's status) target a Worker with no VehicleJob context at all — an idle worker sitting
-- in the queue has none. The FK constraint itself is untouched, it already allows NULL once the
-- column does.
ALTER TABLE "admin_action_logs" ALTER COLUMN "vehicle_job_id" DROP NOT NULL;
