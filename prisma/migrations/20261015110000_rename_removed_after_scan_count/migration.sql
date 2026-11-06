-- The counter now also holds slots Gate added after the team started, not only workers removed after
-- scanning, so it is renamed to what it means: slots the admin still has to fill.
ALTER TABLE "ticket_jobs" RENAME COLUMN "removed_after_scan_count" TO "unfilled_slot_count";
