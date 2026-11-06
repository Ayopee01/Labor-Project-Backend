-- Normalize duplicate job status names across vehicle, market, ticket, confirmation, and assignment flows.

UPDATE "vehicle_jobs"
SET "status" = 'IN_PROGRESS'
WHERE "status" = 'DISPATCH_NOW';

UPDATE "market_jobs"
SET "status" = 'IN_PROGRESS'
WHERE "status" = 'DISPATCH_NOW';

UPDATE "gate_tickets"
SET "status" = CASE "status"
    WHEN 'READY' THEN 'WAIT'
    WHEN 'WAITING_VENDOR_CONFIRM' THEN 'DELIVERED'
    WHEN 'COMPLETION_REJECTED' THEN 'REJECT'
    WHEN 'CLOSED' THEN 'COMPLETED'
    ELSE "status"
  END,
  "confirmation_status" = CASE "confirmation_status"
    WHEN 'NOT_SUBMITTED' THEN 'WAIT'
    WHEN 'WAITING_VENDOR_CONFIRM' THEN 'DELIVERED'
    WHEN 'CONFIRMED' THEN 'COMPLETED'
    WHEN 'REJECTED' THEN 'REJECT'
    ELSE "confirmation_status"
  END
WHERE "status" IN ('READY', 'WAITING_VENDOR_CONFIRM', 'COMPLETION_REJECTED', 'CLOSED')
   OR "confirmation_status" IN ('NOT_SUBMITTED', 'WAITING_VENDOR_CONFIRM', 'CONFIRMED', 'REJECTED');

UPDATE "ticket_completion_submissions"
SET "status" = CASE "status"
    WHEN 'WAITING_VENDOR_CONFIRM' THEN 'DELIVERED'
    WHEN 'CONFIRMED' THEN 'COMPLETED'
    WHEN 'REJECTED' THEN 'REJECT'
    ELSE "status"
  END
WHERE "status" IN ('WAITING_VENDOR_CONFIRM', 'CONFIRMED', 'REJECTED');

UPDATE "ticket_workers"
SET "status" = 'REJECT'
WHERE "status" = 'COMPLETION_REJECTED';

ALTER TABLE "gate_tickets"
ALTER COLUMN "confirmation_status" SET DEFAULT 'WAIT';

ALTER TABLE "ticket_completion_submissions"
ALTER COLUMN "status" SET DEFAULT 'DELIVERED';
