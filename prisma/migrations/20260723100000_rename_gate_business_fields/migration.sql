DROP INDEX IF EXISTS "gate_tickets_ticket_no_idx";

ALTER TABLE "vehicle_jobs"
RENAME COLUMN "vehicle_job_ref" TO "ticket_no";

ALTER TABLE "market_jobs"
RENAME COLUMN "market_job_ref" TO "market_code";

ALTER TABLE "gate_tickets"
RENAME COLUMN "stall_job_ref" TO "booth_code";

UPDATE "gate_tickets"
SET "booth_name" = COALESCE("booth_name", "vendor_name");

ALTER TABLE "gate_tickets"
DROP COLUMN IF EXISTS "ticket_no",
DROP COLUMN IF EXISTS "stall_no",
DROP COLUMN IF EXISTS "vendor_name";

ALTER TABLE "ticket_products"
RENAME COLUMN "product_ref" TO "product_code";

ALTER TABLE "ticket_products"
RENAME COLUMN "name" TO "product_name";

UPDATE "ticket_products"
SET "package_code" = COALESCE("package_code", "product_type", 'UNKNOWN');

UPDATE "ticket_products"
SET "package_name" = COALESCE("package_name", "unit", "package_code", 'UNKNOWN');

ALTER TABLE "ticket_products"
ALTER COLUMN "package_code" SET NOT NULL,
ALTER COLUMN "package_name" SET NOT NULL,
DROP COLUMN IF EXISTS "product_type",
DROP COLUMN IF EXISTS "unit";
