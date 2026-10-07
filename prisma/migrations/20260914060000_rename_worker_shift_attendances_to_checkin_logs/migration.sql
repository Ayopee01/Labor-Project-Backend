-- Rename: worker_shift_attendances -> worker_checkin_logs (and worker_break_logs' FK column along with
-- it) — pure rename for a clearer name ("clock in/out log" instead of the more ambiguous "attendance"),
-- per explicit user choice. Preserves all existing data; every statement below is a RENAME, nothing is
-- dropped or recreated.

ALTER TABLE "worker_shift_attendances" RENAME TO "worker_checkin_logs";

ALTER TABLE "worker_checkin_logs" RENAME CONSTRAINT "worker_shift_attendances_pkey" TO "worker_checkin_logs_pkey";
ALTER TABLE "worker_checkin_logs" RENAME CONSTRAINT "worker_shift_attendances_worker_id_fkey" TO "worker_checkin_logs_worker_id_fkey";

ALTER INDEX "worker_shift_attendances_worker_id_shift_instance_key_key" RENAME TO "worker_checkin_logs_worker_id_shift_instance_key_key";
ALTER INDEX "worker_shift_attendances_worker_code_shift_instance_key_idx" RENAME TO "worker_checkin_logs_worker_code_shift_instance_key_idx";
ALTER INDEX "worker_shift_attendances_closed_at_idx" RENAME TO "worker_checkin_logs_closed_at_idx";

ALTER SEQUENCE "worker_shift_attendances_id_seq" RENAME TO "worker_checkin_logs_id_seq";

-- worker_break_logs: repoint its FK column name at the renamed parent table
ALTER TABLE "worker_break_logs" RENAME COLUMN "worker_shift_attendance_id" TO "worker_checkin_log_id";
ALTER TABLE "worker_break_logs" RENAME CONSTRAINT "worker_break_logs_worker_shift_attendance_id_fkey" TO "worker_break_logs_worker_checkin_log_id_fkey";
ALTER INDEX "worker_break_logs_worker_shift_attendance_id_idx" RENAME TO "worker_break_logs_worker_checkin_log_id_idx";
