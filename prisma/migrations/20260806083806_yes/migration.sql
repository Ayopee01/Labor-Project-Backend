/*
  Warnings:

  - A unique constraint covering the columns `[ticket_id,product_code,package_code]` on the table `ticket_products` will be added. If there are existing duplicate values, this will fail.

*/
-- DropIndex
DROP INDEX "ticket_products_ticket_id_product_code_key";

-- CreateIndex
CREATE UNIQUE INDEX "ticket_products_ticket_id_product_code_package_code_key" ON "ticket_products"("ticket_id", "product_code", "package_code");
