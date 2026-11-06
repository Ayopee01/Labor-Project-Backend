-- Track how many workers an admin removed from a vehicle job after they had already scanned in.
-- workers_required stays at the original team size (so admin can still top the team back up by
-- manual assign), while dispatch and team readiness use (workers_required - removed_after_scan_count)
-- so the system does not auto-dispatch a replacement and the remaining team can keep working/submitting.
-- Reset to 0 when admin sets the vehicle back to wait (dispatch=false) and the whole team is requeued.

ALTER TABLE "ticket_jobs" ADD COLUMN "removed_after_scan_count" INTEGER NOT NULL DEFAULT 0;
