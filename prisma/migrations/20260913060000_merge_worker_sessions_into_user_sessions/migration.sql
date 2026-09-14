-- Merge: worker_sessions folds into user_sessions so Admin and Worker sessions live in one
-- physical table again (they were split apart in 20260831090000_refactor_worker_to_master_worker).
-- Follows the same dual-nullable-FK + role-discriminator convention already used by
-- ticket_completion_submissions (see 20260831090000's submitter_role_check).
--
-- IMPORTANT — per explicit decision, this migration does NOT preserve existing worker_sessions rows.
-- worker_sessions.id and user_sessions.id are separate autoincrement sequences, so a straight
-- INSERT...SELECT would not preserve session ids that worker_push_tokens.session_id still points at.
-- Since this environment's session data is not in real use yet, the simplest safe path is to drop
-- worker_sessions outright and null out any push-token rows that referenced it. Do not run this
-- migration as-is against a database with real worker sessions and clients holding refresh tokens —
-- every worker would be forced to log in again.

-- ============================================================================
-- 1. worker_push_tokens: drop the FK into worker_sessions before that table goes away
-- ============================================================================

ALTER TABLE "worker_push_tokens" DROP CONSTRAINT IF EXISTS "worker_push_tokens_session_id_fkey";
UPDATE "worker_push_tokens" SET "session_id" = NULL;

-- ============================================================================
-- 2. Drop worker_sessions (folded into user_sessions below)
-- ============================================================================

DROP TABLE "worker_sessions";

-- ============================================================================
-- 3. user_sessions: add role discriminator + nullable worker_id, matching worker_sessions' shape
-- ============================================================================

ALTER TABLE "user_sessions" ADD COLUMN "role" VARCHAR(20);
-- Every existing row here predates this migration and was, by definition, an Admin session
-- (Worker sessions lived in worker_sessions until now) — backfill is exact, not a guess.
UPDATE "user_sessions" SET "role" = 'admin';
ALTER TABLE "user_sessions" ALTER COLUMN "role" SET NOT NULL;

ALTER TABLE "user_sessions" ALTER COLUMN "account_id" DROP NOT NULL;
ALTER TABLE "user_sessions" ADD COLUMN "worker_id" INTEGER;

CREATE INDEX "user_sessions_worker_id_is_active_idx" ON "user_sessions"("worker_id", "is_active");

ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_worker_id_fkey"
  FOREIGN KEY ("worker_id") REFERENCES "master_workers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_role_check"
  CHECK (
    ("role" = 'admin' AND "account_id" IS NOT NULL AND "worker_id" IS NULL)
    OR
    ("role" = 'worker' AND "worker_id" IS NOT NULL AND "account_id" IS NULL)
  );

-- ============================================================================
-- 4. worker_push_tokens: repoint session FK at the now-unified user_sessions
-- ============================================================================

ALTER TABLE "worker_push_tokens" ADD CONSTRAINT "worker_push_tokens_session_id_fkey"
  FOREIGN KEY ("session_id") REFERENCES "user_sessions"("id") ON DELETE SET NULL ON UPDATE NO ACTION;
