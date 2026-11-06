-- DropForeignKey
ALTER TABLE "worker_queue_entries" DROP CONSTRAINT IF EXISTS "worker_queue_entries_account_id_fkey";

-- DropTable
DROP TABLE IF EXISTS "worker_queue_entries";
