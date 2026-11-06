// Import Repositories
import * as marketJobRepository from "../repositories/shared/market-job.repository";
import * as assignmentRepository from "../repositories/shared/ticket-job-assignment.repository";
// Import Services
import { listOverdueVendorConfirmations } from "../services/shared/ticket-completion.service";
// Import Queues
import { dispatchReadyWorkers, processAssignmentTimeoutJob, reconcileTimedOutWorkerQueueStates, retryPendingTicketJobClose } from "./worker-dispatch";
// Import Utils
import { runWithChildLogContext } from "../utils/log-context";
import { logger } from "../utils/logger";

/* -------------------------------------- Config -------------------------------------- */

// Config เวลาเผื่อให้ timeout job ปกติทำงานก่อน sweep
const GRACE_MS = 60 * 1000;

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจ assignment, คิวที่ค้าง, รถที่ยังขาดคน และแผงรอ Vendor ที่เลย deadline (สำรองกรณี job หรือ trigger หาย) ด้วยตรรกะเดียวกับ timeout job
export async function runAssignmentTimeoutSweep(): Promise<void> {
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
}
