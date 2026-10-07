-- CreateTable
CREATE TABLE "master_product" (
    "id" INTEGER NOT NULL,
    "product_code" VARCHAR(50) NOT NULL,
    "product_full_code" VARCHAR(50) NOT NULL,
    "product_name" VARCHAR(255) NOT NULL,
    "package_code" VARCHAR(50) NOT NULL,
    "package_name" VARCHAR(100) NOT NULL,
    "package_weight" DOUBLE PRECISION NOT NULL,
    "range" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
    "update_date" TIMESTAMP(3) NOT NULL,
    "create_date" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "master_product_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "master_product_product_full_code_package_code_key" ON "master_product"("product_full_code", "package_code");

-- CreateIndex
CREATE INDEX "master_product_product_code_idx" ON "master_product"("product_code");
