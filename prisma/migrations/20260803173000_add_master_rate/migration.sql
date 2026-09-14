-- CreateTable
CREATE TABLE "master_rate" (
    "id" SERIAL NOT NULL,
    "source_rate_id" INTEGER NOT NULL,
    "market_code" VARCHAR(20) NOT NULL,
    "weight_range_name" VARCHAR(100) NOT NULL,
    "weight_min" DECIMAL(10,2) NOT NULL,
    "weight_max" DECIMAL(10,2) NOT NULL,
    "stall_rate" DECIMAL(10,2) NOT NULL,
    "labor_rate" DECIMAL(10,2) NOT NULL,
    "status" INTEGER NOT NULL,
    "source_created_at" TIMESTAMP(3),
    "source_updated_at" TIMESTAMP(3),
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "master_rate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "master_rate_source_rate_id_key" ON "master_rate"("source_rate_id");

-- CreateIndex
CREATE INDEX "master_rate_market_code_status_idx" ON "master_rate"("market_code", "status");

-- CreateIndex
CREATE INDEX "master_rate_market_code_weight_min_weight_max_status_idx" ON "master_rate"("market_code", "weight_min", "weight_max", "status");
