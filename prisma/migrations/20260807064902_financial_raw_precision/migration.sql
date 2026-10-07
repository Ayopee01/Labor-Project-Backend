-- AlterTable
ALTER TABLE "ticket_product_financials" ALTER COLUMN "stall_fee_raw" SET DATA TYPE DECIMAL(20,4),
ALTER COLUMN "labor_fee_raw" SET DATA TYPE DECIMAL(20,4),
ALTER COLUMN "fund_amount" SET DATA TYPE DECIMAL(20,4);
