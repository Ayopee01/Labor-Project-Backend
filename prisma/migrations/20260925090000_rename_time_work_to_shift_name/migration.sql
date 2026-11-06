-- ชื่อกะเก็บตาม LaborMaster.TimeWork ของ master DB ตรงๆ (Morning / Evening / Not specified / NULL)
-- backend ไม่คำนวณชื่อกะเองอีกต่อไป จึงเปลี่ยนชื่อคอลัมน์ให้สื่อความหมายเป็น shift_name โดยไม่แตะข้อมูลเดิม

-- AlterTable
ALTER TABLE "master_workers" RENAME COLUMN "time_work" TO "shift_name";

-- AlterTable
ALTER TABLE "worker_checkin_logs" RENAME COLUMN "time_work" TO "shift_name";
