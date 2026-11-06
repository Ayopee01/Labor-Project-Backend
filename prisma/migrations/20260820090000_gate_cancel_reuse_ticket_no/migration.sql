-- Allow Gate to reuse a TicketNo after Admin cancels the Ticket (MarketJob) it belonged to.
-- The old full unique index on (vehicle_job_id, ticket_no) blocked this outright — replace it
-- with a partial unique index that only applies to non-cancelled rows, so a cancelled row never
-- blocks a fresh Gate create under the same ticket_no, while two ACTIVE rows can still never
-- collide. Cancelled rows are kept as-is (history), never deleted or reused in place.
DROP INDEX "market_jobs_vehicle_job_id_ticket_no_key";

CREATE UNIQUE INDEX "market_jobs_vehicle_job_id_ticket_no_active_key"
  ON "market_jobs" ("vehicle_job_id", "ticket_no")
  WHERE "status" <> 'CANCELLED';

-- Plain (non-unique) index so lookups by (vehicle_job_id, ticket_no) that must see cancelled
-- rows too (e.g. admin history) stay fast.
CREATE INDEX "market_jobs_vehicle_job_id_ticket_no_idx"
  ON "market_jobs" ("vehicle_job_id", "ticket_no");
