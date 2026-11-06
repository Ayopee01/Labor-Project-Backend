ALTER TABLE "worker_push_tokens" DROP CONSTRAINT IF EXISTS "worker_push_tokens_account_id_fkey";

DROP INDEX IF EXISTS "worker_push_tokens_account_id_is_active_idx";

ALTER TABLE "worker_push_tokens" DROP COLUMN IF EXISTS "account_id";
