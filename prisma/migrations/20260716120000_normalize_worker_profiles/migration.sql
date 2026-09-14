-- Make accounts the source of truth for worker code and phone.
UPDATE "accounts" AS account
SET
  "username" = profile."worker_code",
  "phone" = COALESCE(account."phone", profile."phone")
FROM "user_profiles" AS profile
WHERE account."id" = profile."account_id"
  AND account."role" = 'worker';

ALTER TABLE "user_profiles" RENAME TO "worker_profiles";

ALTER INDEX IF EXISTS "user_profiles_pkey" RENAME TO "worker_profiles_pkey";
ALTER INDEX IF EXISTS "user_profiles_account_id_key" RENAME TO "worker_profiles_account_id_key";
ALTER INDEX IF EXISTS "user_profiles_worker_code_key" RENAME TO "worker_profiles_worker_code_key";

ALTER TABLE "worker_profiles" RENAME CONSTRAINT "user_profiles_account_id_fkey" TO "worker_profiles_account_id_fkey";

DROP INDEX IF EXISTS "worker_profiles_worker_code_key";
ALTER TABLE "worker_profiles" DROP COLUMN IF EXISTS "worker_code";
ALTER TABLE "worker_profiles" DROP COLUMN IF EXISTS "phone";
