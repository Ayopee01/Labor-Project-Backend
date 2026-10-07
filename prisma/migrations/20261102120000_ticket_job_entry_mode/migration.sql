-- ที่มาของงานรถ: SYSTEM = สร้างจาก Gate ตาม flow ปกติ, MANUAL = Admin บันทึกงานย้อนหลัง
ALTER TABLE "ticket_jobs" ADD COLUMN "entry_mode" VARCHAR(20) NOT NULL DEFAULT 'SYSTEM';

ALTER TABLE "ticket_jobs" ADD CONSTRAINT "ticket_jobs_entry_mode_check" CHECK ("entry_mode" IN ('SYSTEM', 'MANUAL'));
