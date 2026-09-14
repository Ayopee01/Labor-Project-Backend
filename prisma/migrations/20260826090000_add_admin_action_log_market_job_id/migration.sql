-- Admin can cancel a whole Business Ticket (market job) via
-- POST /vehicle-jobs/{ticketNumber}/tickets/{ticketNo}/cancel. That action previously had no
-- audit trail at all (no admin_action_logs row), so Daily Worker Income could not report who
-- cancelled a TicketNo or why. admin_action_logs already scopes narrower than vehicle_job_id via
-- the optional gate_ticket_id column; add the same optional scoping for market_job_id so a
-- market-level action can be attributed without forcing every log row to pick a single booth.
ALTER TABLE "admin_action_logs" ADD COLUMN "market_job_id" INTEGER;

CREATE INDEX "admin_action_logs_market_job_id_created_at_idx" ON "admin_action_logs"("market_job_id", "created_at");

ALTER TABLE "admin_action_logs" ADD CONSTRAINT "admin_action_logs_market_job_id_fkey" FOREIGN KEY ("market_job_id") REFERENCES "market_jobs"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
