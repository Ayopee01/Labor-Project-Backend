-- Merge: gate_ticket_worker_snapshots + submission_worker_snapshots fold into one worker_snapshots
-- table (dual nullable FK: gate_ticket_id / submission_id), same convention as the user_sessions merge
-- in 20260913060000. Per explicit decision, existing rows in both tables are test data only — dropped
-- outright rather than migrated. Do not run this against an environment with real snapshot data
-- (ticket-financial.service.ts uses gate_ticket_worker_snapshots as the payout divisor) without first
-- writing a data-preserving version of this migration.

DROP TABLE "gate_ticket_worker_snapshots";
DROP TABLE "submission_worker_snapshots";

CREATE TABLE "worker_snapshots" (
    "id" SERIAL NOT NULL,
    "gate_ticket_id" INTEGER,
    "submission_id" INTEGER,
    "ticket_worker_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "worker_snapshots_gate_ticket_id_ticket_worker_id_key" ON "worker_snapshots"("gate_ticket_id", "ticket_worker_id");
CREATE UNIQUE INDEX "worker_snapshots_submission_id_ticket_worker_id_key" ON "worker_snapshots"("submission_id", "ticket_worker_id");
CREATE INDEX "worker_snapshots_ticket_worker_id_idx" ON "worker_snapshots"("ticket_worker_id");

ALTER TABLE "worker_snapshots" ADD CONSTRAINT "worker_snapshots_gate_ticket_id_fkey"
  FOREIGN KEY ("gate_ticket_id") REFERENCES "gate_tickets"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "worker_snapshots" ADD CONSTRAINT "worker_snapshots_submission_id_fkey"
  FOREIGN KEY ("submission_id") REFERENCES "ticket_completion_submissions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "worker_snapshots" ADD CONSTRAINT "worker_snapshots_ticket_worker_id_fkey"
  FOREIGN KEY ("ticket_worker_id") REFERENCES "ticket_workers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
