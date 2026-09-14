// Import Library
import { Queue, Worker } from "bullmq";
// Import Config
import { buildBullConnection, REDIS_CONFIG } from "../config/redis.config";
// Import Service
import { runSecurityAuditLogRetentionCleanup } from "../services/shared/security-audit-log.service";
// Import Utils
import { logger } from "../utils/logger";

/* -------------------------------------- Config -------------------------------------- */

const QUEUE_NAME = process.env.BULLMQ_SECURITY_AUDIT_LOG_CLEANUP_QUEUE ?? "security-audit-log-cleanup";
const JOB_NAME = "cleanup"; 
const REPEATABLE_JOB_ID = "security-audit-log-cleanup-daily";
const RUN_EVERY_MS = 24 * 60 * 60 * 1000;

const bullConnection = buildBullConnection();

const cleanupQueue = new Queue(QUEUE_NAME, { connection: bullConnection });

let cleanupWorker: Worker | null = null;

/* -------------------------------------- Functions -------------------------------------- */

// Function ลงทะเบียน repeatable job ของ retention cleanup เรียกซ้ำได้ปลอดภัยเพราะ BullMQ ใช้ jobId เดิมแทนที่ schedule เก่า
export async function scheduleSecurityAuditLogCleanup(): Promise<void> {
  await cleanupQueue.add(
    JOB_NAME,
    {},
    {
      repeat: { every: RUN_EVERY_MS },
      jobId: REPEATABLE_JOB_ID,
    }
  );
}

// Function เริ่ม worker ที่ประมวลผล retention cleanup job
export function startSecurityAuditLogCleanupWorker(): void {
  if (cleanupWorker) {
    return;
  }

  cleanupWorker = new Worker(
    QUEUE_NAME,
    async () => {
      await runSecurityAuditLogRetentionCleanup();
    },
    { connection: bullConnection }
  );

  cleanupWorker.on("failed", (_job, error) => {
    logger.error("Security audit log cleanup job failed.", { error });
  });
}

// Function ปิด Redis/BullMQ connections ของ retention cleanup สำหรับ graceful shutdown
export async function closeSecurityAuditLogCleanupConnections(): Promise<void> {
  if (cleanupWorker) {
    await cleanupWorker.close();
    cleanupWorker = null;
  }

  await cleanupQueue.close();
}
