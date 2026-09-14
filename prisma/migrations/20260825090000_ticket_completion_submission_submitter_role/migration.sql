-- Rename to a role-agnostic name: this table now also supports Admin submitting/overriding
-- counts on behalf of a Worker, not exclusively Worker self-submissions.
ALTER TABLE "ticket_completion_submissions" RENAME COLUMN "submitted_by_worker_account_id" TO "submitted_by_account_id";

-- Snapshot of who submitted ("worker" or "admin") at submission time — must never be derived by
-- joining Account.role later, since that can change after the fact (e.g. an admin account
-- demoted). Backfill existing rows as "worker": Admin submitting on behalf did not exist before
-- this migration, so every historical row is genuinely a Worker's own submission.
ALTER TABLE "ticket_completion_submissions" ADD COLUMN "submitted_by_role" VARCHAR(20) NOT NULL DEFAULT 'worker';
ALTER TABLE "ticket_completion_submissions" ALTER COLUMN "submitted_by_role" DROP DEFAULT;
