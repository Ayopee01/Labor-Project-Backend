CREATE TABLE "ticket_ratings" (
    "id" SERIAL NOT NULL,
    "ticket_id" INTEGER NOT NULL,
    "submission_id" INTEGER NOT NULL,
    "line_user_id" VARCHAR(255) NOT NULL,
    "target_type" VARCHAR(20),
    "score" INTEGER NOT NULL,
    "rated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_ratings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ticket_ratings_score_check" CHECK ("score" >= 1 AND "score" <= 5)
);

CREATE UNIQUE INDEX "ticket_ratings_ticket_id_line_user_id_key" ON "ticket_ratings"("ticket_id", "line_user_id");
CREATE INDEX "ticket_ratings_submission_id_idx" ON "ticket_ratings"("submission_id");
CREATE INDEX "ticket_ratings_score_idx" ON "ticket_ratings"("score");

ALTER TABLE "ticket_ratings" ADD CONSTRAINT "ticket_ratings_ticket_id_fkey" FOREIGN KEY ("ticket_id") REFERENCES "gate_tickets"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
ALTER TABLE "ticket_ratings" ADD CONSTRAINT "ticket_ratings_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "ticket_completion_submissions"("id") ON DELETE CASCADE ON UPDATE NO ACTION;
