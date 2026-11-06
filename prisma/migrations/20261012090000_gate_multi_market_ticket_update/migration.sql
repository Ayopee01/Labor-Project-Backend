-- Gate ส่งหลายตลาดใน request เดียว, บันทึก GateNo/Gate client และรองรับ PUT แก้ไขตั๋ว

-- AlterTable: ประเภทรถ (code) ไว้คืนให้ Gate ตอน GET ตั๋ว
ALTER TABLE "ticket_jobs" ADD COLUMN "vehicle_type_code" VARCHAR(50);

-- AlterTable: Gate ที่ออกตั๋วแต่ละใบ
ALTER TABLE "market_jobs" ADD COLUMN "gate_no" VARCHAR(50),
ADD COLUMN "gate_client_id" INTEGER;

ALTER TABLE "market_jobs" ADD CONSTRAINT "market_jobs_gate_client_id_fkey"
  FOREIGN KEY ("gate_client_id") REFERENCES "gate_clients"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AlterTable: แยก request สร้าง/แก้ไข พร้อม Gate ที่ยิงและสรุปการเปลี่ยนแปลง
ALTER TABLE "gate_request_logs" ADD COLUMN "request_type" VARCHAR(20) NOT NULL DEFAULT 'CREATE',
ADD COLUMN "gate_no" VARCHAR(50),
ADD COLUMN "gate_client_id" INTEGER,
ADD COLUMN "change_summary" JSONB;

ALTER TABLE "gate_request_logs" ADD CONSTRAINT "gate_request_logs_gate_client_id_fkey"
  FOREIGN KEY ("gate_client_id") REFERENCES "gate_clients"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE INDEX "gate_request_logs_market_job_id_created_at_idx" ON "gate_request_logs"("market_job_id", "created_at");

-- AlterTable: จำนวน Worker ต่อสินค้าตอนสร้าง (แถวเดิมเป็น null ระบบคิดจาก Master แทน)
ALTER TABLE "ticket_products" ADD COLUMN "required_worker_count_snapshot" INTEGER;

-- AlterTable: Gate เป็นผู้ทำรายการได้ (actor_account_id เป็น null)
ALTER TABLE "admin_action_logs" ALTER COLUMN "actor_account_id" DROP NOT NULL,
ADD COLUMN "actor_gate_client_id" INTEGER;

ALTER TABLE "admin_action_logs" ADD CONSTRAINT "admin_action_logs_actor_gate_client_id_fkey"
  FOREIGN KEY ("actor_gate_client_id") REFERENCES "gate_clients"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- BoothCode เดิมสร้างแถวใหม่ได้หลังแถวเดิมถูกยกเลิก (Gate แก้สินค้าของแผง) แต่แถวที่ active ห้ามชนกัน
DROP INDEX "booth_jobs_market_job_id_booth_code_key";

CREATE UNIQUE INDEX "booth_jobs_market_job_id_booth_code_active_key"
  ON "booth_jobs" ("market_job_id", "booth_code")
  WHERE "status" <> 'CANCELLED';

CREATE INDEX "booth_jobs_market_job_id_booth_code_idx" ON "booth_jobs"("market_job_id", "booth_code");
