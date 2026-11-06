-- VehicleJob.completedAt: set once, at the single central lifecycle point
-- (closeCompletedVehicleJobIfReady -> updateVehicleJobStatus) that transitions status to
-- COMPLETED. Authoritative source for Work History's completed_at, replacing the previous
-- MAX(MarketJob.completedAt) derivation.
ALTER TABLE "vehicle_jobs" ADD COLUMN "completed_at" TIMESTAMP(3);

-- TicketCompletionSubmission.rejectReason: reason captured per-submission at reject time,
-- unlike GateTicket.reject_reason which only ever holds the latest/current reason and gets
-- overwritten by later submissions. Needed for Work History's per-rejection audit trail.
ALTER TABLE "ticket_completion_submissions" ADD COLUMN "reject_reason" TEXT;
