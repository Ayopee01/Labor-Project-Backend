-- Add an external product reference so clients do not need ticket_products.id.
ALTER TABLE "ticket_products" ADD COLUMN "product_ref" VARCHAR(100);

-- Backfill existing development data from the internal id before making it required.
UPDATE "ticket_products"
SET "product_ref" = 'PRODUCT-' || "id"::text
WHERE "product_ref" IS NULL;

ALTER TABLE "ticket_products" ALTER COLUMN "product_ref" SET NOT NULL;

CREATE UNIQUE INDEX "ticket_products_ticket_id_product_ref_key"
ON "ticket_products"("ticket_id", "product_ref");
