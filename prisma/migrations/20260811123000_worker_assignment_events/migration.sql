CREATE TABLE "worker_assignment_events" (
  "id" SERIAL NOT NULL,
  "assignment_id" INTEGER NOT NULL,
  "worker_account_id" INTEGER NOT NULL,
  "vehicle_job_id" INTEGER NOT NULL,
  "event_type" VARCHAR(30) NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "worker_assignment_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "worker_assignment_events_assignment_id_event_type_key"
ON "worker_assignment_events"("assignment_id", "event_type");

CREATE INDEX "worker_assignment_events_worker_account_id_occurred_at_idx"
ON "worker_assignment_events"("worker_account_id", "occurred_at");

CREATE INDEX "worker_assignment_events_worker_account_id_event_type_occurred_at_idx"
ON "worker_assignment_events"("worker_account_id", "event_type", "occurred_at");

CREATE INDEX "worker_assignment_events_assignment_id_occurred_at_idx"
ON "worker_assignment_events"("assignment_id", "occurred_at");

CREATE INDEX "worker_assignment_events_vehicle_job_id_idx"
ON "worker_assignment_events"("vehicle_job_id");

CREATE INDEX "worker_assignment_events_event_type_occurred_at_idx"
ON "worker_assignment_events"("event_type", "occurred_at");

ALTER TABLE "worker_assignment_events"
ADD CONSTRAINT "worker_assignment_events_assignment_id_fkey"
FOREIGN KEY ("assignment_id") REFERENCES "vehicle_job_assignments"("id")
ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "worker_assignment_events"
ADD CONSTRAINT "worker_assignment_events_worker_account_id_fkey"
FOREIGN KEY ("worker_account_id") REFERENCES "accounts"("id")
ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "worker_assignment_events"
ADD CONSTRAINT "worker_assignment_events_vehicle_job_id_fkey"
FOREIGN KEY ("vehicle_job_id") REFERENCES "vehicle_jobs"("id")
ON DELETE NO ACTION ON UPDATE NO ACTION;
