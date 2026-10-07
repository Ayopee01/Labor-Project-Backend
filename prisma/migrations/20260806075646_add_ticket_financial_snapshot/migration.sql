-- AlterTable
ALTER TABLE "gate_tickets" ADD COLUMN     "completed_at" TIMESTAMP(3),
ADD COLUMN     "final_stall_amount" DECIMAL(18,2),
ADD COLUMN     "financialized_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "line_action_tokens" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ticket_products" ADD COLUMN     "labor_rate_snapshot" DECIMAL(10,2),
ADD COLUMN     "package_weight_snapshot" DECIMAL(12,2),
ADD COLUMN     "product_full_code" VARCHAR(100),
ADD COLUMN     "rate_id_snapshot" INTEGER,
ADD COLUMN     "rate_market_code" VARCHAR(20),
ADD COLUMN     "rate_snapshot_at" TIMESTAMP(3),
ADD COLUMN     "rate_source" VARCHAR(30),
ADD COLUMN     "source_rate_id_snapshot" INTEGER,
ADD COLUMN     "stall_rate_snapshot" DECIMAL(10,2),
ADD COLUMN     "weight_max_snapshot" DECIMAL(10,2),
ADD COLUMN     "weight_min_snapshot" DECIMAL(10,2),
ADD COLUMN     "weight_range_name" VARCHAR(100);

-- AlterTable
ALTER TABLE "ticket_ratings" ALTER COLUMN "updated_at" DROP DEFAULT;

-- AlterTable
ALTER TABLE "ticket_workers" ADD COLUMN     "cancelled_at" TIMESTAMP(3),
ADD COLUMN     "completed_at" TIMESTAMP(3),
ADD COLUMN     "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "worker_shift_attendances" ALTER COLUMN "updated_at" DROP DEFAULT;

-- CreateTable
CREATE TABLE "ticket_product_financials" (
    "id" SERIAL NOT NULL,
    "ticket_product_id" INTEGER NOT NULL,
    "confirmed_quantity" DECIMAL(12,2) NOT NULL,
    "stall_fee_raw" DECIMAL(18,2) NOT NULL,
    "stall_fee_rounded" DECIMAL(18,2) NOT NULL,
    "labor_fee_raw" DECIMAL(18,2) NOT NULL,
    "product_charge" DECIMAL(18,2) NOT NULL,
    "worker_count" INTEGER NOT NULL,
    "worker_payout_total" DECIMAL(18,2) NOT NULL,
    "fund_amount" DECIMAL(18,2) NOT NULL,
    "finalized_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_product_financials_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ticket_worker_payments" (
    "id" SERIAL NOT NULL,
    "ticket_product_financial_id" INTEGER NOT NULL,
    "ticket_worker_id" INTEGER NOT NULL,
    "raw_amount" DECIMAL(20,8) NOT NULL,
    "remainder_amount" DECIMAL(20,8) NOT NULL,
    "final_amount" DECIMAL(18,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ticket_worker_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ticket_product_financials_ticket_product_id_key" ON "ticket_product_financials"("ticket_product_id");

-- CreateIndex
CREATE INDEX "ticket_product_financials_finalized_at_idx" ON "ticket_product_financials"("finalized_at");

-- CreateIndex
CREATE INDEX "ticket_worker_payments_ticket_worker_id_idx" ON "ticket_worker_payments"("ticket_worker_id");

-- CreateIndex
CREATE INDEX "ticket_worker_payments_ticket_product_financial_id_idx" ON "ticket_worker_payments"("ticket_product_financial_id");

-- CreateIndex
CREATE UNIQUE INDEX "ticket_worker_payments_ticket_product_financial_id_ticket_w_key" ON "ticket_worker_payments"("ticket_product_financial_id", "ticket_worker_id");

-- CreateIndex
CREATE INDEX "ticket_products_rate_market_code_idx" ON "ticket_products"("rate_market_code");

-- CreateIndex
CREATE INDEX "ticket_workers_ticket_id_status_idx" ON "ticket_workers"("ticket_id", "status");

-- RenameForeignKey
ALTER TABLE "ticket_completion_submissions" RENAME CONSTRAINT "ticket_completion_submissions_submitted_by_worker_account_id_fk" TO "ticket_completion_submissions_submitted_by_worker_account__fkey";

-- AddForeignKey
ALTER TABLE "ticket_product_financials" ADD CONSTRAINT "ticket_product_financials_ticket_product_id_fkey" FOREIGN KEY ("ticket_product_id") REFERENCES "ticket_products"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ticket_worker_payments" ADD CONSTRAINT "ticket_worker_payments_ticket_product_financial_id_fkey" FOREIGN KEY ("ticket_product_financial_id") REFERENCES "ticket_product_financials"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "ticket_worker_payments" ADD CONSTRAINT "ticket_worker_payments_ticket_worker_id_fkey" FOREIGN KEY ("ticket_worker_id") REFERENCES "ticket_workers"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- RenameIndex
ALTER INDEX "market_jobs_vehicle_job_id_market_job_ref_key" RENAME TO "market_jobs_vehicle_job_id_market_code_key";

-- RenameIndex
ALTER INDEX "master_member_stalls_market_code_owner_id_card_owner_line_use_k" RENAME TO "master_member_stalls_market_code_owner_id_card_owner_line_u_key";

-- RenameIndex
ALTER INDEX "master_member_stalls_market_code_owner_id_card_owner_line_user_" RENAME TO "master_member_stalls_market_code_owner_id_card_owner_line_u_idx";
