// Import Library
import { Queue, Worker } from "bullmq";
// Import Services
import { runSecurityAuditLogRetentionCleanup } from "../services/shared/security-audit-log.service";
// Import Queues
import { runAssignmentTimeoutSweep } from "./assignment-timeout-sweep";
import { bullWorkerConnection } from "./bull-connection";
import { checkLineMessageQuota } from "./line-message-queue";
// Import Utils
import { runWithLogContext } from "../utils/log-context";
import { logger } from "../utils/logger";

/* -------------------------------------- Config -------------------------------------- */

// Config queue เดียวของงานดูแลระบบที่ทำซ้ำเป็นรอบ (ใช้ worker ตัวเดียว ประหยัด Redis connection)
const QUEUE_NAME = process.env.BULLMQ_MAINTENANCE_QUEUE ?? "maintenance";

// Config งานที่ทำซ้ำ: sweep assignment ทุก 2 นาที, เช็คโควต้า LINE ทุกชั่วโมง, ลบ SecurityAuditLog เก่าวันละครั้ง
const MAINTENANCE_JOBS = [
  {
    name: "assignment-timeout-sweep",
    schedulerId: "assignment-timeout-sweep-periodic",
    everyMs: 2 * 60 * 1000,
    run: runAssignmentTimeoutSweep,
  },
  {
    name: "line-quota-check",
    schedulerId: "line-quota-check-hourly",
    everyMs: 60 * 60 * 1000,
    run: checkLineMessageQuota,
  },
  {
    name: "security-audit-log-cleanup",
    schedulerId: "security-audit-log-cleanup-daily",
    everyMs: 24 * 60 * 60 * 1000,
    run: runSecurityAuditLogRetentionCleanup,
  },
] as const;

const maintenanceQueue = new Queue(QUEUE_NAME, { connection: bullWorkerConnection });

let maintenanceWorker: Worker | null = null;

/* -------------------------------------- Functions -------------------------------------- */

// Function ลงทะเบียนงานดูแลระบบทุกตัวแบบทำซ้ำด้วย Job Scheduler (เรียกซ้ำได้ เพราะใช้ scheduler id เดิม)
export async function scheduleMaintenanceJobs(): Promise<void> {
  for (const job of MAINTENANCE_JOBS) {
    await maintenanceQueue.upsertJobScheduler(
      job.schedulerId,
      { every: job.everyMs },
      // ลบ job ที่รันเสร็จทิ้ง ไม่งั้นทุกรอบที่ทำซ้ำจะค้างอยู่ใน Redis สะสมไปเรื่อยๆ
      { name: job.name, data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } }
    );
  }
}

// Function เริ่ม worker ที่ประมวลผลงานดูแลระบบตามชื่อ job (concurrency 1 = sweep ไม่ทับกันเอง)
export function startMaintenanceWorker(): void {
  if (maintenanceWorker) {
    return;
  }

  maintenanceWorker = new Worker(
    QUEUE_NAME,
    async (job) => runWithLogContext({ jobName: job.name, jobId: job.id }, async () => {
      const maintenanceJob = MAINTENANCE_JOBS.find(({ name }) => name === job.name);

      if (!maintenanceJob) {
        logger.error("Unknown maintenance job.", { jobName: job.name, jobId: job.id });
        return;
      }

      await maintenanceJob.run();
    }),
    { connection: bullWorkerConnection }
  );

  maintenanceWorker.on("failed", (job, error) => {
    logger.error("Maintenance job failed.", { jobName: job?.name, jobId: job?.id, error });
  });
}

// Function ปิด queue และ worker ของงานดูแลระบบสำหรับ graceful shutdown
export async function closeMaintenanceQueueConnections(): Promise<void> {
  if (maintenanceWorker) {
    await maintenanceWorker.close();
    maintenanceWorker = null;
  }

  await maintenanceQueue.close();
}
