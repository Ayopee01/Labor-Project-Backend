ALTER TABLE "ticket_completion_submissions"
  ADD COLUMN "resolved_by_line_user_id" VARCHAR(255);

CREATE INDEX "ticket_completion_submissions_resolved_by_line_user_id_idx"
  ON "ticket_completion_submissions"("resolved_by_line_user_id");
