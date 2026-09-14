ALTER TABLE "vehicle_jobs"
ADD COLUMN "vehicle_type" VARCHAR(100);

ALTER TABLE "ticket_products"
ADD COLUMN "product_type" VARCHAR(100),
ADD COLUMN "confirmed_quantity" DECIMAL(12,2);

ALTER TABLE "ticket_completion_submissions"
DROP COLUMN "amount",
DROP COLUMN "note";
