ALTER TABLE "accounts"
ADD COLUMN "source" VARCHAR(30) NOT NULL DEFAULT 'internal',
ADD COLUMN "master_worker_id" VARCHAR(100),
ADD COLUMN "master_updated_at" TIMESTAMP(3),
ADD COLUMN "synced_at" TIMESTAMP(3);

CREATE UNIQUE INDEX "accounts_master_worker_id_key" ON "accounts"("master_worker_id");
CREATE INDEX "accounts_role_source_idx" ON "accounts"("role", "source");
CREATE INDEX "accounts_master_updated_at_idx" ON "accounts"("master_updated_at");
