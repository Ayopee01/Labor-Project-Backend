CREATE TABLE "worker_push_tokens" (
    "id" SERIAL NOT NULL,
    "worker_code" VARCHAR(100) NOT NULL,
    "account_id" INTEGER,
    "session_id" INTEGER,
    "device_id" VARCHAR(255) NOT NULL,
    "platform" VARCHAR(30) NOT NULL DEFAULT 'unknown',
    "fcm_token" TEXT NOT NULL,
    "fcm_token_hash" VARCHAR(64) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worker_push_tokens_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "worker_push_tokens_fcm_token_hash_idx" ON "worker_push_tokens"("fcm_token_hash");
CREATE UNIQUE INDEX "worker_push_tokens_worker_code_device_id_platform_key" ON "worker_push_tokens"("worker_code", "device_id", "platform");
CREATE INDEX "worker_push_tokens_worker_code_is_active_idx" ON "worker_push_tokens"("worker_code", "is_active");
CREATE INDEX "worker_push_tokens_account_id_is_active_idx" ON "worker_push_tokens"("account_id", "is_active");
CREATE INDEX "worker_push_tokens_session_id_is_active_idx" ON "worker_push_tokens"("session_id", "is_active");

ALTER TABLE "worker_push_tokens" ADD CONSTRAINT "worker_push_tokens_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "worker_push_tokens" ADD CONSTRAINT "worker_push_tokens_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "user_sessions"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
