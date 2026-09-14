-- TicketCompletionSubmission.assignmentId: the VehicleJobAssignment the submitting worker was
-- actively working under at the exact moment this submission was created. Nullable and
-- intentionally never backfilled -- existing rows created before this migration, and rows
-- submitted by an admin on a worker's behalf (the admin account has no assignment of its own),
-- have no reliable value here.
ALTER TABLE "ticket_completion_submissions" ADD COLUMN "assignment_id" INTEGER;

-- CreateIndex
CREATE INDEX "ticket_completion_submissions_assignment_id_idx" ON "ticket_completion_submissions"("assignment_id");

-- AddForeignKey
ALTER TABLE "ticket_completion_submissions" ADD CONSTRAINT "ticket_completion_submissions_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "vehicle_job_assignments"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
