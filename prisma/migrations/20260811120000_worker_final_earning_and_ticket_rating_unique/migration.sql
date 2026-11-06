-- Add persisted Worker x Booth final earning.
ALTER TABLE "ticket_workers"
ADD COLUMN "final_earning_amount" DECIMAL(18, 2);

-- Backfill historical finalized worker booth earnings from persisted payment rows only.
UPDATE "ticket_workers" AS tw
SET "final_earning_amount" = payments."final_earning_amount"
FROM (
  SELECT
    "ticket_worker_id",
    SUM("final_amount")::DECIMAL(18, 2) AS "final_earning_amount"
  FROM "ticket_worker_payments"
  GROUP BY "ticket_worker_id"
) AS payments
WHERE tw."id" = payments."ticket_worker_id";

-- Keep the deterministic first rating per ticket before enforcing one rating per GateTicket.
WITH ranked_ratings AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "ticket_id"
      ORDER BY "rated_at" ASC, "created_at" ASC, "id" ASC
    ) AS row_number
  FROM "ticket_ratings"
)
DELETE FROM "ticket_ratings"
WHERE "id" IN (
  SELECT "id"
  FROM ranked_ratings
  WHERE row_number > 1
);

ALTER TABLE "ticket_ratings"
DROP CONSTRAINT IF EXISTS "ticket_ratings_ticket_id_line_user_id_key";

ALTER TABLE "ticket_ratings"
ADD CONSTRAINT "ticket_ratings_ticket_id_key" UNIQUE ("ticket_id");
