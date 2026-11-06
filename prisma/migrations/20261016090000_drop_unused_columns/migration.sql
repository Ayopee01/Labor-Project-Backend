-- ลบคอลัมน์ที่ไม่มีโค้ดส่วนไหนใช้งานแล้ว และเพิ่ม picture_hash สำหรับอัปโหลดรูป Worker ขึ้น Spaces

-- master_workers: สถานะใช้ status (ตัวเลข), เสื้อใช้ coat_no, ไม่แยกแหล่งที่มาของ worker
DROP INDEX "master_workers_source_idx";

ALTER TABLE "master_workers" DROP COLUMN "labor_coat",
DROP COLUMN "labor_status",
DROP COLUMN "source";

-- master_workers: SHA-256 ของรูปที่อัปโหลดขึ้น Spaces แล้ว ใช้ดูว่ารูปเปลี่ยนต้องอัปโหลดใหม่หรือไม่
ALTER TABLE "master_workers" ADD COLUMN "picture_hash" CHAR(64);

-- worker_checkin_logs: นับ timeout ติดกันด้วย accept_timeout_streak อย่างเดียว
ALTER TABLE "worker_checkin_logs" DROP COLUMN "last_accept_timeout_at";

-- ticket_jobs: จำนวนตั๋วนับจาก market_jobs ได้โดยตรง
ALTER TABLE "ticket_jobs" DROP COLUMN "expected_ticket_count";

-- master_member_stalls: ข้อมูลเจ้าของแผงอ่านจาก master_owner_stalls
ALTER TABLE "master_member_stalls" DROP COLUMN "owner_code",
DROP COLUMN "owner_name",
DROP COLUMN "owner_telephone";

-- master_*: วันที่สร้างของระบบต้นทางไม่ได้ใช้ (sync ใช้รหัสต้นทางและวันที่อัปเดต)
ALTER TABLE "master_market" DROP COLUMN "source_booth_created_at",
DROP COLUMN "source_market_created_at";

ALTER TABLE "master_product" DROP COLUMN "create_date";

ALTER TABLE "master_rate" DROP COLUMN "source_created_at";
