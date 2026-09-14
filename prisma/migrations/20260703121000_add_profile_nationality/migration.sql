ALTER TABLE "user_profiles" ADD COLUMN "nationality" VARCHAR(100);

UPDATE "user_profiles"
SET "nationality" = "nationality_name"
WHERE "nationality" IS NULL;

ALTER TABLE "user_profiles" ALTER COLUMN "nationality" SET NOT NULL;
