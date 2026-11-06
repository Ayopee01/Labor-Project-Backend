-- เวลาที่คิดเงิน Worker ของแผงใหม่ล่าสุดหลังปิดยอด
ALTER TABLE "booth_jobs" ADD COLUMN "last_recalculated_at" TIMESTAMP(3);
