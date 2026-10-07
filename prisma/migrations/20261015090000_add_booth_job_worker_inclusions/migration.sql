-- Admin picks which workers join a booth the vendor rejected (REJECT), capped at workers_required.
-- Rows point at master_workers (not ticket_workers) because a newly added worker has no roster
-- row in the market until they scan in.
CREATE TABLE "booth_job_worker_inclusions" (
    "id" SERIAL NOT NULL,
    "booth_job_id" INTEGER NOT NULL,
    "worker_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booth_job_worker_inclusions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "booth_job_worker_inclusions_booth_job_id_worker_id_key" ON "booth_job_worker_inclusions"("booth_job_id", "worker_id");

CREATE INDEX "booth_job_worker_inclusions_worker_id_idx" ON "booth_job_worker_inclusions"("worker_id");

ALTER TABLE "booth_job_worker_inclusions" ADD CONSTRAINT "booth_job_worker_inclusions_booth_job_id_fkey" FOREIGN KEY ("booth_job_id") REFERENCES "booth_jobs"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "booth_job_worker_inclusions" ADD CONSTRAINT "booth_job_worker_inclusions_worker_id_fkey" FOREIGN KEY ("worker_id") REFERENCES "master_workers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
