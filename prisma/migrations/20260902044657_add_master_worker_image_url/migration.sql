-- DropIndex
DROP INDEX "ticket_ratings_ticket_id_line_user_id_key";

-- DropIndex
DROP INDEX "worker_notifications_notification_key_created_at_idx";

-- AlterTable
ALTER TABLE "master_workers" ADD COLUMN     "image_url" VARCHAR(512);

-- AlterTable
ALTER TABLE "worker_notifications" ALTER COLUMN "updated_at" DROP DEFAULT;

-- RenameIndex
ALTER INDEX "gate_ticket_worker_exclusions_gate_ticket_ticket_worker_key" RENAME TO "gate_ticket_worker_exclusions_gate_ticket_id_ticket_worker__key";

-- RenameIndex
ALTER INDEX "gate_ticket_worker_snapshots_gate_ticket_id_ticket_worker__key" RENAME TO "gate_ticket_worker_snapshots_gate_ticket_id_ticket_worker_i_key";

-- RenameIndex
ALTER INDEX "mobile_app_versions_release_notification_idx" RENAME TO "mobile_app_versions_release_notification_at_release_notific_idx";

-- RenameIndex
ALTER INDEX "submission_worker_snapshots_submission_id_ticket_worker_i_key" RENAME TO "submission_worker_snapshots_submission_id_ticket_worker_id_key";
