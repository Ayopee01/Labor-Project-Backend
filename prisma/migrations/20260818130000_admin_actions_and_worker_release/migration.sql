-- Admin can release a worker's team early (before the whole TicketNumber closes) once they
-- have submitted all their assigned booths. Distinct from `completed_at` (whole vehicle job
-- done); `released_at` marks only this worker's own work as done early.
ALTER TABLE "vehicle_job_assignments" ADD COLUMN "released_at" TIMESTAMP(3);

-- Central audit log for Admin actions on a VehicleJob that need a reason + actor + timeline
-- entry (override count, force wait, release workers, ...). Kept generic/append-only rather
-- than adding cancelled_by/waited_by/released_by columns scattered across multiple tables.
CREATE TABLE "admin_action_logs" (
    "id" SERIAL NOT NULL,
    "vehicle_job_id" INTEGER NOT NULL,
    "gate_ticket_id" INTEGER,
    "action_type" VARCHAR(40) NOT NULL,
    "reason_code" VARCHAR(50),
    "reason_text" TEXT,
    "actor_account_id" INTEGER NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_action_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_action_logs_vehicle_job_id_created_at_idx" ON "admin_action_logs"("vehicle_job_id", "created_at");

CREATE INDEX "admin_action_logs_gate_ticket_id_created_at_idx" ON "admin_action_logs"("gate_ticket_id", "created_at");

CREATE INDEX "admin_action_logs_action_type_created_at_idx" ON "admin_action_logs"("action_type", "created_at");

ALTER TABLE "admin_action_logs" ADD CONSTRAINT "admin_action_logs_vehicle_job_id_fkey" FOREIGN KEY ("vehicle_job_id") REFERENCES "vehicle_jobs"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "admin_action_logs" ADD CONSTRAINT "admin_action_logs_gate_ticket_id_fkey" FOREIGN KEY ("gate_ticket_id") REFERENCES "gate_tickets"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "admin_action_logs" ADD CONSTRAINT "admin_action_logs_actor_account_id_fkey" FOREIGN KEY ("actor_account_id") REFERENCES "accounts"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
