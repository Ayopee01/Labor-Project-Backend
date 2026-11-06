-- ย้ายยอดแผงไป ticket_products รอบ 2: ลบ column ยอดแผงเดิมใน ticket_product_financials
-- ยืนยันแล้วว่าค่าใน ticket_products ตรงกับ column เหล่านี้ทุกแถวก่อนลบ (ข้อมูลใน column เหล่านี้หายถาวร)

-- AlterTable
ALTER TABLE "ticket_product_financials" DROP COLUMN "stall_fee_raw",
DROP COLUMN "stall_fee_rounded",
DROP COLUMN "labor_fee_raw",
DROP COLUMN "product_charge";
