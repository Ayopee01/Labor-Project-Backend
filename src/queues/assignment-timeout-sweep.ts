// Import Library
import { Queue, Worker } from "bullmq";
// Import Config
import { buildBullConnection } from "../config/redis.config";
// Import Repositories
import * as assignmentRepository from "../repositories/shared/ticket-job-assignment.repository";
// Import Queues
import { processAssignmentTimeoutJob } from "./worker-dispatch";
// Import Utils
import { logger } from "../utils/logger";

/* -------------------------------------- Config -------------------------------------- */

// ตาข่ายกันกรณี accept/scan timeout job ของ assignment หนึ่งพังไปจน retry หมด (ดู worker-queue.ts) แล้วไม่มี
// อะไรมาประมวลผลซ้ำอีก ทำให้ assignment ค้างสถานะ PENDING/ACCEPTED ถาวรทั้งที่เลย deadline ไปแล้ว
const QUEUE_NAME = process.env.BULLMQ_ASSIGNMENT_TIMEOUT_SWEEP_QUEUE ?? "assignment-timeout-sweep";
const JOB_NAME = "sweep";
const REPEATABLE_JOB_ID = "assignment-timeout-sweep-periodic";
const RUN_EVERY_MS = 2 * 60 * 1000;
// เผื่อเวลาให้ BullMQ job ปกติ (รวม retry) มีโอกาสประมวลผลก่อนเสมอ กัน sweep แย่งประมวลผล assignment
// เดียวกันซ้อนกับ job ที่กำลังจะ fire พอดี (ประมวลผลซ้ำได้อย่างปลอดภัยอยู่แล้วเพราะ timeoutAssignment เป็น
// conditional update แต่ไม่จำเป็นต้องทำงานซ้ำโดยไม่มีเหตุผล)
const GRACE_MS = 60 * 1000;

const bullConnection = buildBullConnection();

const sweepQueue = new Queue(QUEUE_NAME, { connection: bullConnection });

let sweepWorker: Worker | null = null;

/* -------------------------------------- Functions -------------------------------------- */

// Function ลงทะเบียน repeatable job ของ sweep เรียกซ้ำได้ปลอดภัยเพราะ BullMQ ใช้ jobId เดิมแทนที่ schedule เก่า
export async function scheduleAssignmentTimeoutSweep(): Promise<void> {
  await sweepQueue.add(
    JOB_NAME,
    {},
    {
      repeat: { every: RUN_EVERY_MS },
      jobId: REPEATABLE_JOB_ID,
    }
  );
}

// Function เริ่ม worker ที่ประมวลผล sweep job — หา assignment ที่เลย deadline มาแล้วแต่ยังไม่ TIMEOUT แล้ว
// เรียกตรรกะเดียวกับ BullMQ timeout job ปกติซ้ำผ่าน processAssignmentTimeoutJob
export function startAssignmentTimeoutSweepWorker(): void {
  if (sweepWorker) {
    return;
  }

  sweepWorker = new Worker(
    QUEUE_NAME,
    async () => {
      const overdueAssignments = await assignmentRepository.listOverdueAssignments(GRACE_MS);

      for (const assignment of overdueAssignments) {
        try {
          await processAssignmentTimeoutJob({
            assignmentId: assignment.id,
            workerId: assignment.worker_id,
            kind: assignment.kind,
          });
        } catch (error) {
          logger.error("Assignment timeout sweep failed to reprocess an assignment.", {
            assignmentId: assignment.id,
            workerId: assignment.worker_id,
            kind: assignment.kind,
            error,
          });
        }
      }
    },
    { connection: bullConnection }
  );

  sweepWorker.on("failed", (_job, error) => {
    logger.error("Assignment timeout sweep job failed.", { error });
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
