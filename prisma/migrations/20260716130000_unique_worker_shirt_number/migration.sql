-- Shirt numbers are worker identifiers and must not be reused.
CREATE UNIQUE INDEX "worker_profiles_shirt_number_key"
ON "worker_profiles" ("shirt_number");
