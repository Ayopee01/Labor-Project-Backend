-- Keep nationality as a single worker profile field.
ALTER TABLE "worker_profiles" DROP COLUMN IF EXISTS "nationality_code";
ALTER TABLE "worker_profiles" DROP COLUMN IF EXISTS "nationality_name";
