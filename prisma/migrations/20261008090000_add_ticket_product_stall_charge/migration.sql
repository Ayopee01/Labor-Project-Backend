-- ย้ายยอดแผงรายสินค้าไปเก็บที่ ticket_products (คิดตอน Vendor ยืนยัน) รอบ 1: เพิ่ม column และ backfill
-- column เดิมใน ticket_product_financials ยังไม่ลบ (รอบ 2)

-- AlterTable
ALTER TABLE "ticket_products" ADD COLUMN     "stall_fee_raw" DECIMAL(20,4),
ADD COLUMN     "stall_fee_rounded" DECIMAL(18,2),
ADD COLUMN     "labor_fee_raw" DECIMAL(20,4),
ADD COLUMN     "product_charge" DECIMAL(18,2);

-- UpdateData: สินค้าที่ปิดยอดแล้ว คัดลอกจาก ticket_product_financials
UPDATE "ticket_products" AS tp
SET "stall_fee_raw" = tpf."stall_fee_raw",
    "stall_fee_rounded" = tpf."stall_fee_rounded",
    "labor_fee_raw" = tpf."labor_fee_raw",
    "product_charge" = tpf."product_charge"
FROM "ticket_product_financials" AS tpf
WHERE tpf."ticket_product_id" = tp."id";

-- UpdateData: แผงที่ยืนยันแล้วแต่ยังไม่ปิดยอด คำนวณด้วยสูตรเดียวกับ calculateProductStallCharge
UPDATE "ticket_products" AS tp
SET "stall_fee_raw" = tp."confirmed_quantity" * tp."stall_rate_snapshot",
    "stall_fee_rounded" = CEIL(tp."confirmed_quantity" * tp."stall_rate_snapshot"),
    "labor_fee_raw" = tp."confirmed_quantity" * tp."labor_rate_snapshot",
    "product_charge" = CEIL(
      CEIL(tp."confirmed_quantity" * tp."stall_rate_snapshot")
      + tp."confirmed_quantity" * tp."labor_rate_snapshot"
    )
FROM "booth_jobs" AS bj
WHERE bj."id" = tp."ticket_id"
  AND bj."status" = 'COMPLETED'
  AND bj."financialized_at" IS NULL
  AND tp."stall_fee_raw" IS NULL
  AND tp."confirmed_quantity" IS NOT NULL
  AND tp."stall_rate_snapshot" IS NOT NULL
  AND tp."labor_rate_snapshot" IS NOT NULL;

-- UpdateData: ยอดรวมของแผงที่ยืนยันแล้วแต่ยังไม่ปิดยอด (ข้ามแผงที่มีสินค้าคิดยอดไม่ได้ ให้ finalize แจ้ง error เหมือนเดิม)
UPDATE "booth_jobs" AS bj
SET "final_stall_amount" = COALESCE(
  (SELECT SUM(tp."product_charge") FROM "ticket_products" AS tp WHERE tp."ticket_id" = bj."id"),
  0
)
WHERE bj."status" = 'COMPLETED'
  AND bj."financialized_at" IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM "ticket_products" AS tp
    WHERE tp."ticket_id" = bj."id" AND tp."product_charge" IS NULL
  );
