-- TicketNo ห้ามซ้ำทั้งระบบ รวมตั๋วที่ Admin ยกเลิกแล้ว (ยกเลิกแล้วต้องออกเลขใหม่ ไม่นำเลขเดิมกลับมาใช้)
DROP INDEX "market_jobs_ticket_no_active_key";

CREATE UNIQUE INDEX "market_jobs_ticket_no_key" ON "market_jobs"("ticket_no");
