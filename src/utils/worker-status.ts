import { ASSIGNMENT_STATUS, WORKING_ASSIGNMENT_STATUSES } from "../constants/status";
import type { TicketJobAssignmentDto, VehicleWorkReadinessDto, WorkerQueueEntryDto } from "../types/worker.type";
import { WORKER_WORK_STATUS, type WorkerWorkStatus } from "../types/shared/worker-status.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function แปลง state ภายในของคิว/assignment เป็น 6 สถานะ worker สำหรับ UI
export function resolveWorkerWorkStatus(
  queue: WorkerQueueEntryDto | null,
  assignment: TicketJobAssignmentDto | null,
  teamScanReadiness?: Pick<VehicleWorkReadinessDto, "is_ready"> | null,
): WorkerWorkStatus {
  if (queue?.status === WORKER_WORK_STATUS.BREAK) {
    return WORKER_WORK_STATUS.BREAK;
  }

  if (
    queue?.status === WORKER_WORK_STATUS.READY &&
    assignment?.status === ASSIGNMENT_STATUS.DELIVERED
  ) {
    return WORKER_WORK_STATUS.READY;
  }

  if (assignment) {
    if (WORKING_ASSIGNMENT_STATUSES.includes(assignment.status)) {
      if (teamScanReadiness?.is_ready === false) {
        return WORKER_WORK_STATUS.WAITING_TEAM;
      }

      return WORKER_WORK_STATUS.WORKING;
    }

    return WORKER_WORK_STATUS.ASSIGNED;
  }

  if (queue?.status === WORKER_WORK_STATUS.READY) {
    return WORKER_WORK_STATUS.READY;
  }

  if (
    queue?.status === WORKER_WORK_STATUS.ASSIGNED ||
    queue?.status === WORKER_WORK_STATUS.WORKING
  ) {
    return queue.status;
  }

  return WORKER_WORK_STATUS.OPEN_APP;
}
