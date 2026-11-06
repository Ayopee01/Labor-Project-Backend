-- TicketNo ห้ามซ้ำกับตั๋วที่ยังไม่ถูกยกเลิก (ทุกรถ) เพราะ GET/PUT ของ Gate หาตั๋วจาก TicketNo อย่างเดียว
-- ตั๋วที่ยกเลิกแล้วไม่นับ จึงออกเลขเดิมใหม่ได้หลังยกเลิก
CREATE UNIQUE INDEX "market_jobs_ticket_no_active_key"
  ON "market_jobs" ("ticket_no")
  WHERE "status" <> 'CANCELLED';

-- index เดิมที่บังคับไม่ซ้ำเฉพาะในรถคันเดียวกัน ซ้ำซ้อนกับ index ด้านบนแล้ว
DROP INDEX "market_jobs_ticket_job_id_ticket_no_active_key";
