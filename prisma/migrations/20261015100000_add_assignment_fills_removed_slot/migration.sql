-- Marks an assignment the admin added to fill an unfilled slot (removed_after_scan_count) after the
-- team started. Scanning it gives the slot back; timing out does not dispatch a replacement.
ALTER TABLE "ticket_job_assignments" ADD COLUMN "fills_removed_slot" BOOLEAN NOT NULL DEFAULT false;
