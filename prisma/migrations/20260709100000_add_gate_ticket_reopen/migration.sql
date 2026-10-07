CREATE TABLE "gate_ticket_status_histories" (
  "id" SERIAL NOT NULL,
  "ticket_id" INTEGER NOT NULL,
  "from_status" VARCHAR(30) NOT NULL,
  "to_status" VARCHAR(30) NOT NULL,
  "action" VARCHAR(100) NOT NULL,
  "changed_by_account_id" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "gate_ticket_status_histories_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "gate_ticket_status_histories_ticket_id_created_at_idx"
  ON "gate_ticket_status_histories"("ticket_id", "created_at");

CREATE INDEX "gate_ticket_status_histories_changed_by_account_id_idx"
  ON "gate_ticket_status_histories"("changed_by_account_id");

ALTER TABLE "gate_ticket_status_histories"
  ADD CONSTRAINT "gate_ticket_status_histories_ticket_id_fkey"
  FOREIGN KEY ("ticket_id") REFERENCES "gate_tickets"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "gate_ticket_status_histories"
  ADD CONSTRAINT "gate_ticket_status_histories_changed_by_account_id_fkey"
  FOREIGN KEY ("changed_by_account_id") REFERENCES "accounts"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;

INSERT INTO "account_permissions" ("account_id", "permission", "updated_at")
SELECT "id", 'jobs:reopen', CURRENT_TIMESTAMP
FROM "accounts"
WHERE "role" = 'admin'
  AND "permission_level" IN ('manager', 'supervisor')
ON CONFLICT ("account_id", "permission") DO NOTHING;
