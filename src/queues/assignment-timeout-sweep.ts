// Import Library
import { Queue, Worker } from "bullmq";
// Import Config
import { buildBullConnection } from "../config/redis.config";
// Import Repositories
import * as marketJobRepository from "../repositories/shared/market-job.repository";
import * as assignmentRepository from "../repositories/shared/ticket-job-assignment.repository";
// Import Services
import { listOverdueVendorConfirmations } from "../services/shared/ticket-completion.service";
// Import Queues
import { dispatchReadyWorkers, processAssignmentTimeoutJob, reconcileTimedOutWorkerQueueStates, retryPendingTicketJobClose } from "./worker-dispatch";
// Import Utils
import { runWithChildLogContext, runWithLogContext } from "../utils/log-context";
import { logger } from "../utils/logger";

/* -------------------------------------- Config -------------------------------------- */

// Config queue ที่ตรวจ assignment, คิวที่ค้าง, รถที่ยังขาดคน และแผงรอ Vendor ที่เลย deadline (สำรองกรณี job หรือ trigger หาย) ทุก 2 นาที
const QUEUE_NAME = process.env.BULLMQ_ASSIGNMENT_TIMEOUT_SWEEP_QUEUE ?? "assignment-timeout-sweep";
const JOB_NAME = "sweep";
const REPEATABLE_JOB_ID = "assignment-timeout-sweep-periodic";
const RUN_EVERY_MS = 2 * 60 * 1000;
// Config เวลาเผื่อให้ timeout job ปกติทำงานก่อน sweep
const GRACE_MS = 60 * 1000;

// Config BullMQ connection, queue และ worker ของ sweep
const bullConnection = buildBullConnection();

const sweepQueue = new Queue(QUEUE_NAME, { connection: bullConnection });

let sweepWorker: Worker | null = null;

/* -------------------------------------- Functions -------------------------------------- */

// Function ลงทะเบียน job sweep แบบทำซ้ำด้วย Job Scheduler (เรียกซ้ำได้ เพราะใช้ scheduler id เดิม)
export async function scheduleAssignmentTimeoutSweep(): Promise<void> {
  await sweepQueue.upsertJobScheduler(
    REPEATABLE_JOB_ID,
    { every: RUN_EVERY_MS },
    // ลบ job ที่รันเสร็จทิ้ง ไม่งั้นทุกรอบที่ทำซ้ำจะค้างอยู่ใน Redis สะสมไปเรื่อยๆ
    { name: JOB_NAME, data: {}, opts: { removeOnComplete: true, removeOnFail: 100 } }
  );
}

// Function เริ่ม worker ของ sweep ที่ timeout assignment และ auto-confirm แผงที่ค้างด้วยตรรกะเดียวกับ timeout job
export function startAssignmentTimeoutSweepWorker(): void {
  if (sweepWorker) {
    return;
  }

  sweepWorker = new Worker(
    QUEUE_NAME,
    async (job) => runWithLogContext({ jobName: QUEUE_NAME, jobId: job.id }, async () => {
      const overdueAssignments = await assignmentRepository.listOverdueAssignments(GRACE_MS);

      for (const assignment of overdueAssignments) {
        try {
          await runWithChildLogContext({}, () => processAssignmentTimeoutJob({
            assignmentId: assignment.id,
            workerId: assignment.worker_id,
            kind: assignment.kind,
          }));
        } catch (error) {
          logger.error("Assignment timeout sweep failed to reprocess an assignment.", {
            assignmentId: assignment.id,
            workerId: assignment.worker_id,
            kind: assignment.kind,
            error,
          });
        }
      }

      // ลองปิดยอดตลาดที่แผงจบครบแล้วแต่ปิดยอดไม่สำเร็จ (เช่น ข้อมูลเพิ่งถูกแก้ให้ครบ)
      for (const ticketJobId of await marketJobRepository.listTicketJobIdsAwaitingFinalize()) {
        try {
          await runWithChildLogContext({ ticketJobId }, () => retryPendingTicketJobClose(ticketJobId));
        } catch (error) {
          logger.error("Assignment timeout sweep failed to retry closing a vehicle job.", {
            ticketJobId,
            error,
          });
        }
      }

      // กู้ worker ที่ timeout แล้วแต่คิว Redis ค้าง assigned (เขียนคิวหลัง commit ไม่สำเร็จ)
      try {
        await reconcileTimedOutWorkerQueueStates();
      } catch (error) {
        logger.error("Assignment timeout sweep failed to reconcile timed-out worker queue states.", { error });
      }

      // safety net: รถที่ยังขาดคนถูกตรวจซ้ำทุกรอบ ไม่ต้องรอ worker คนใหม่เข้าคิว (กรณี trigger หลุด)
      try {
        await dispatchReadyWorkers();
      } catch (error) {
        logger.error("Assignment timeout sweep failed to dispatch pending vehicle jobs.", { error });
      }

      const overdueVendorConfirmations = await listOverdueVendorConfirmations(GRACE_MS);

      for (const { ticketId, submissionId } of overdueVendorConfirmations) {
        try {
          await runWithChildLogContext({}, () => processAssignmentTimeoutJob({
            ticketId,
            submissionId,
            kind: "vendor_confirm",
          }));
        } catch (error) {
          logger.error("Assignment timeout sweep failed to auto-confirm an overdue ticket submission.", {
            ticketId,
            submissionId,
            error,
          });
        }
      }
    }),
    { connection: bullConnection }
  );

  sweepWorker.on("failed", (job, error) => {
    logger.error("Assignment timeout sweep job failed.", { jobName: QUEUE_NAME, jobId: job?.id, error });
  });
}

// Function ปิด Redis/BullMQ connections ของ sweep job สำหรับ graceful shutdown
export async function closeAssignmentTimeoutSweepConnections(): Promise<void> {
  if (sweepWorker) {
    await sweepWorker.close();
    sweepWorker = null;
  }

  await sweepQueue.close();
}
