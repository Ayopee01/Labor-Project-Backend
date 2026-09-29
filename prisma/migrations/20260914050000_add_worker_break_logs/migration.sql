-- Add: worker_break_logs — historical log of each break a worker takes during a shift (started_at,
-- scheduled_end_at, ended_at, end_reason). Previously break state only lived in Redis (current status +
-- a same-day count with TTL), with no durable history of when breaks actually started/ended. Purely
-- additive: no existing table or column is touched.

CREATE TABLE "worker_break_logs" (
    "id" SERIAL NOT NULL,
    "worker_shift_attendance_id" INTEGER NOT NULL,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduled_end_at" TIMESTAMP(3) NOT NULL,
    "ended_at" TIMESTAMP(3),
    "end_reason" VARCHAR(30),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worker_break_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "worker_break_logs_worker_shift_attendance_id_idx" ON "worker_break_logs"("worker_shift_attendance_id");
CREATE INDEX "worker_break_logs_ended_at_idx" ON "worker_break_logs"("ended_at");

ALTER TABLE "worker_break_logs" ADD CONSTRAINT "worker_break_logs_worker_shift_attendance_id_fkey"
  FOREIGN KEY ("worker_shift_attendance_id") REFERENCES "worker_shift_attendances"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
