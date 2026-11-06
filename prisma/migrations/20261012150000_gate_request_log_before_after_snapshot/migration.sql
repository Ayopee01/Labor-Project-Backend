-- Gate ticket edits now update the existing MarketJob/BoothJob/TicketProduct rows in place
-- (identity kept) instead of cancelling and recreating them. Keep a revision of every edit on the
-- request log: the ticket state before and after the edit (market, dropoff point, booths, products).

ALTER TABLE "gate_request_logs" ADD COLUMN "before_snapshot" JSONB,
ADD COLUMN "after_snapshot" JSONB;
