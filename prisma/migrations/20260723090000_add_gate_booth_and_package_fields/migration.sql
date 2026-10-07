ALTER TABLE "gate_tickets"
ADD COLUMN "booth_name" VARCHAR(255);

ALTER TABLE "ticket_products"
ADD COLUMN "package_code" VARCHAR(100),
ADD COLUMN "package_name" VARCHAR(255);
