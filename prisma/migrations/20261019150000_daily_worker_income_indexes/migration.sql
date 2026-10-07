-- ช่วงวันที่ของรายงานรายได้ worker รายวัน (completed_at ถ้าไม่มีใช้ joined_at)
CREATE INDEX "ticket_workers_completed_at_id_idx" ON "ticket_workers"("completed_at", "id");
CREATE INDEX "ticket_workers_joined_at_id_idx" ON "ticket_workers"("joined_at", "id");

-- หา assignment ล่าสุดของ worker ในงานรถ
CREATE INDEX "ticket_job_assignments_ticket_job_id_worker_id_created_at_idx" ON "ticket_job_assignments"("ticket_job_id", "worker_id", "created_at");
