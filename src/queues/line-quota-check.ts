// Import Library
import { Queue, Worker } from "bullmq";
// Import Config
import { buildBullConnection } from "../config/redis.config";
// Import Queues
import { checkLineMessageQuota } from "./line-message-queue";
// Import Utils
import { runWithLogContext } from "../utils/log-context";
import { logger } from "../utils/logger";

/* -------------------------------------- Config -------------------------------------- */

// Config queue ที่เช็คโควต้าข้อความรายเดือนของ LINE ทุกชั่วโมง
const QUEUE_NAME = process.env.BULLMQ_LINE_QUOTA_CHECK_QUEUE ?? "line-quota-check";
const JOB_NAME = "check";
const REPEATABLE_JOB_ID = "line-quota-check-hourly";
const RUN_EVERY_MS = 60 * 60 * 1000;

// Config BullMQ connection, queue และ worker ของการเช็คโควต้า
const bullConnection = buildBullConnection();

const quotaCheckQueue = new Queue(QUEUE_NAME, { connection: bullConnection });

let quotaCheckWorker: Worker | null = null;

/* -------------------------------------- Functions -------------------------------------- */

// Function ลงทะเบียน job เช็คโควต้า LINE แบบทำซ้ำด้วย Job Scheduler (เรียกซ้ำได้ เพราะใช้ scheduler id เดิม)
export async function scheduleLineQuotaCheck(): Promise<void> {
  await quotaCheckQueue.upsertJobScheduler(
    REPEATABLE_JOB_ID,
    { every: RUN_EVERY_MS },
    { name: JOB_NAME, data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } }
  );
}

// Function เริ่ม worker ที่ประมวลผล job เช็คโควต้า LINE
export function startLineQuotaCheckWorker(): void {
  if (quotaCheckWorker) {
    return;
  }

  quotaCheckWorker = new Worker(
    QUEUE_NAME,
    async (job) => runWithLogContext({ jobName: QUEUE_NAME, jobId: job.id }, () => checkLineMessageQuota()),
    { connection: bullConnection }
  );

  quotaCheckWorker.on("failed", (_job, error) => {
    logger.error("LINE quota check job failed.", { jobName: QUEUE_NAME, error });
  });
}

// Function ปิด Redis/BullMQ connections ของการเช็คโควต้า LINE สำหรับ graceful shutdown
export async function closeLineQuotaCheckConnections(): Promise<void> {
  if (quotaCheckWorker) {
    await quotaCheckWorker.close();
    quotaCheckWorker = null;
  }

  await quotaCheckQueue.close();
}
