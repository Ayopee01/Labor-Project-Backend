-- CreateTable
CREATE TABLE "master_market" (
    "id" SERIAL NOT NULL,
    "source_market_id" INTEGER,
    "source_booth_id" INTEGER NOT NULL,
    "market_code" VARCHAR(20) NOT NULL,
    "market_name" VARCHAR(255),
    "booth_code" VARCHAR(50) NOT NULL,
    "booth_name" VARCHAR(255) NOT NULL,
    "market_status" VARCHAR(20),
    "booth_status" VARCHAR(20) NOT NULL,
    "source_market_created_at" TIMESTAMP(3),
    "source_market_updated_at" TIMESTAMP(3),
    "source_booth_created_at" TIMESTAMP(3),
    "source_booth_updated_at" TIMESTAMP(3),
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "master_market_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "master_market_source_booth_id_key" ON "master_market"("source_booth_id");

-- CreateIndex
CREATE UNIQUE INDEX "master_market_market_code_booth_code_key" ON "master_market"("market_code", "booth_code");

-- CreateIndex
CREATE INDEX "master_market_market_code_booth_status_idx" ON "master_market"("market_code", "booth_status");

-- CreateIndex
CREATE INDEX "master_market_booth_code_idx" ON "master_market"("booth_code");
