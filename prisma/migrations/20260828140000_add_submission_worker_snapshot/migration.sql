-- Snapshot of which TicketWorker rows were WORKING at the exact moment one specific
-- TicketCompletionSubmission was created -- captures the roster at Submit time, distinct from
-- GateTicketWorkerSnapshot which captures the roster later at Confirm time. A worker
-- cancelled/reassigned between Submit and Confirm makes these two snapshots diverge. Used by Work
-- History's SubmissionWorkerSnapshot[], never the payout divisor.
CREATE TABLE "submission_worker_snapshots" (
    "id" SERIAL NOT NULL,
    "submission_id" INTEGER NOT NULL,
    "ticket_worker_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "submission_worker_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "submission_worker_snapshots_submission_id_ticket_worker_i_key" ON "submission_worker_snapshots"("submission_id", "ticket_worker_id");

-- CreateIndex
CREATE INDEX "submission_worker_snapshots_ticket_worker_id_idx" ON "submission_worker_snapshots"("ticket_worker_id");

-- AddForeignKey
ALTER TABLE "submission_worker_snapshots" ADD CONSTRAINT "submission_worker_snapshots_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "ticket_completion_submissions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "submission_worker_snapshots" ADD CONSTRAINT "submission_worker_snapshots_ticket_worker_id_fkey" FOREIGN KEY ("ticket_worker_id") REFERENCES "ticket_workers"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
