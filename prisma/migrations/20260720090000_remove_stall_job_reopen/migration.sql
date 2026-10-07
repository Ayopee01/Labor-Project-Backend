DELETE FROM "account_permissions"
WHERE "permission" = 'jobs:reopen';

DROP TABLE IF EXISTS "gate_ticket_status_histories";
