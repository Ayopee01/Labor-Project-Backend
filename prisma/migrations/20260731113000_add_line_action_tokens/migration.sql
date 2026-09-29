CREATE TABLE "line_action_tokens" (
  "id" SERIAL PRIMARY KEY,
  "token" VARCHAR(80) NOT NULL,
  "action" VARCHAR(50) NOT NULL,
  "ticket_id" INTEGER NOT NULL,
  "submission_id" INTEGER NOT NULL,
  "booth_code" VARCHAR(100) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "used_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "line_action_tokens_token_key" ON "line_action_tokens"("token");
CREATE INDEX "line_action_tokens_ticket_id_idx" ON "line_action_tokens"("ticket_id");
CREATE INDEX "line_action_tokens_submission_id_idx" ON "line_action_tokens"("submission_id");
CREATE INDEX "line_action_tokens_action_expires_at_idx" ON "line_action_tokens"("action", "expires_at");

ALTER TABLE "line_action_tokens"
  ADD CONSTRAINT "line_action_tokens_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "gate_tickets"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "line_action_tokens"
  ADD CONSTRAINT "line_action_tokens_submission_id_fkey"
  FOREIGN KEY ("submission_id") REFERENCES "ticket_completion_submissions"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;
