import { ASSIGNMENT_STATUS, SHIFT_INACTIVE_REASON, WORKER_OPEN_APP_REASON, WORKING_ASSIGNMENT_STATUSES } from "../constants/status";
import type { TicketJobAssignmentDto, VehicleWorkReadinessDto, WorkerQueueEntryDto, WorkerShiftCloseReason } from "../types/worker.type";
import { WORKER_WORK_STATUS, type WorkerWorkStatus } from "../types/shared/worker-status.type";
import type { ShiftInactiveReasonCode } from "./shift-status-localization";

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

// Function ตัดสิน shift_active + reason_code ของ worker คนหนึ่ง ใช้ร่วมกันทั้ง GET /api/workers/me/status
// (ฝั่ง worker เช็คสถานะตัวเอง) และ GET /api/admin/jobs/workers/status (ฝั่ง Admin ดู list เพื่อ force เข้าคิว)
// เพื่อไม่ให้ logic ตัดสินโค้ดสองฝั่งเพี้ยนไปจากกัน
export function resolveShiftActiveStatus(input: {
  isWithinShiftTime: boolean;
  closedAt: unknown;
  closeReason: string | null | undefined;
  firstOnlineAt: unknown;
  queueStatus: WorkerWorkStatus | null | undefined;
  openAppReason: string | null | undefined;
}): { active: boolean; reasonCode?: ShiftInactiveReasonCode } {
  // ถ้า queue status ปัจจุบันไม่ใช่ open_app แล้ว (เช่น Admin force กลับเข้าคิวให้แล้ว หรือกำลังทำงาน/พักอยู่)
  // ถือว่า active เสมอ ไม่โชว์ reason_code ค้างจากประวัติเก่า — closedAt/closeReason ใน WorkerCheckinLog ไม่ถูก
  // เคลียร์ตอน Admin force สถานะ (forceAdminWorkerStatus ไม่แตะ attendance เลย) จึงต้องเช็ค queue status สด
  // เป็นตัวตัดสินหลักก่อนเสมอ ไม่งั้น reason_code จะค้างแสดงทั้งที่ worker กลับมาทำงานได้ปกติแล้ว
  if (input.queueStatus != null && input.queueStatus !== WORKER_WORK_STATUS.OPEN_APP) {
    return { active: true };
  }

  if (!input.isWithinShiftTime) {
    return { active: false, reasonCode: SHIFT_INACTIVE_REASON.OUTSIDE_SHIFT };
  }

  if (input.closedAt != null) {
    // นาฬิกายังอยู่ในเวลากะ (ผ่านเช็ค isWithinShiftTime ด้านบนมาแล้ว) แต่ attendance ของกะนี้ถูกปิดไปแล้ว —
    // เคยเข้ากะ (Go Online) แล้วแต่ออกไปแล้ว ไม่ว่าจะออกเอง (worker_offline/worker_logout), ระบบปิดให้ตอนหมด
    // เวลากะ (shift_ended/ticket_delivered_after_shift_end), หรือ Admin ปิดให้ (admin_session_revoked) — ผล
    // เหมือนกันคือกลับเข้าคิวเองไม่ได้ ต้องรอ Admin force ยกเว้น assignment_timeout_limit_reached ที่แยกโค้ด
    // เฉพาะไว้แล้วเพราะมีสาเหตุ (ไม่กดรับงานครบจำนวน) ที่ชัดเจนกว่า
    const reasonCode =
      input.closeReason ===
      ("assignment_timeout_limit_reached" satisfies WorkerShiftCloseReason)
        ? SHIFT_INACTIVE_REASON.ACCEPT_TIMEOUT_LIMIT_REACHED
        : SHIFT_INACTIVE_REASON.SHIFT_ALREADY_CLOSED;

    return { active: false, reasonCode };
  }

  const isEligible =
    input.firstOnlineAt == null || input.queueStatus !== WORKER_WORK_STATUS.OPEN_APP;

  if (isEligible) {
    return { active: true };
  }

  switch (input.openAppReason) {
    case WORKER_OPEN_APP_REASON.SCAN_TIMEOUT:
      return { active: false, reasonCode: SHIFT_INACTIVE_REASON.SCAN_TIMEOUT };
    case WORKER_OPEN_APP_REASON.ADMIN_CANCEL_ASSIGNMENT:
      return { active: false, reasonCode: SHIFT_INACTIVE_REASON.ADMIN_CANCELLED_ASSIGNMENT };
    case WORKER_OPEN_APP_REASON.ADMIN_FORCED_STATUS:
      return { active: false, reasonCode: SHIFT_INACTIVE_REASON.ADMIN_FORCED_STATUS };
    case WORKER_OPEN_APP_REASON.BREAK_RETRY_EXPIRED:
      return { active: false, reasonCode: SHIFT_INACTIVE_REASON.BREAK_RETRY_EXPIRED };
    // BREAK_ENDED_AWAITING_RECONNECT (และ reason อื่นที่ยังไม่รู้จัก) ไม่ map เป็น reason_code ตั้งใจ — ยังมี
    // โอกาส self-resolve ได้เอง ไม่ต้องพึ่ง Admin
    default:
      return { active: false };
  }
}
