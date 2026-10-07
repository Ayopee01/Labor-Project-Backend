ALTER TABLE "accounts"
ADD COLUMN "lang" VARCHAR(10) NOT NULL DEFAULT 'th';

CREATE TABLE "worker_notifications" (
    "id" SERIAL NOT NULL,
    "worker_account_id" INTEGER NOT NULL,
    "type" VARCHAR(100) NOT NULL,
    "title" VARCHAR(255) NOT NULL,
    "message" TEXT NOT NULL,
    "payload" JSONB,
    "read_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "worker_notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "worker_notifications_worker_account_id_created_at_idx"
ON "worker_notifications"("worker_account_id", "created_at");

CREATE INDEX "worker_notifications_worker_account_id_read_at_idx"
ON "worker_notifications"("worker_account_id", "read_at");

CREATE INDEX "worker_notifications_type_created_at_idx"
ON "worker_notifications"("type", "created_at");

ALTER TABLE "worker_notifications"
ADD CONSTRAINT "worker_notifications_worker_account_id_fkey"
FOREIGN KEY ("worker_account_id") REFERENCES "accounts"("id")
ON DELETE CASCADE ON UPDATE NO ACTION;
