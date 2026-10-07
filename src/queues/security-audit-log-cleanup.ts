// Import Library
import { Queue, Worker } from "bullmq";
// Import Config
import { buildBullConnection } from "../config/redis.config";
// Import Services
import { runSecurityAuditLogRetentionCleanup } from "../services/shared/security-audit-log.service";
// Import Utils
import { logger } from "../utils/logger";

/* -------------------------------------- Config -------------------------------------- */

// Config queue ที่ลบ SecurityAuditLog เก่าวันละครั้ง
const QUEUE_NAME = process.env.BULLMQ_SECURITY_AUDIT_LOG_CLEANUP_QUEUE ?? "security-audit-log-cleanup";
const JOB_NAME = "cleanup"; 
const REPEATABLE_JOB_ID = "security-audit-log-cleanup-daily";
const RUN_EVERY_MS = 24 * 60 * 60 * 1000;

// Config BullMQ connection, queue และ worker ของ cleanup
const bullConnection = buildBullConnection();

const cleanupQueue = new Queue(QUEUE_NAME, { connection: bullConnection });

let cleanupWorker: Worker | null = null;

/* -------------------------------------- Functions -------------------------------------- */

// Function ลงทะเบียน job ลบ log เก่าแบบทำซ้ำด้วย Job Scheduler (เรียกซ้ำได้ เพราะใช้ scheduler id เดิม)
export async function scheduleSecurityAuditLogCleanup(): Promise<void> {
  await cleanupQueue.upsertJobScheduler(
    REPEATABLE_JOB_ID,
    { every: RUN_EVERY_MS },
    { name: JOB_NAME, data: {} }
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
