export const WORKER_ASSIGNMENT_EVENT_TYPE = {
  ASSIGNED: "ASSIGNED",
  ACCEPTED: "ACCEPTED",
  ACCEPT_TIMEOUT: "ACCEPT_TIMEOUT",
  SCANNED: "SCANNED",
  SCAN_TIMEOUT: "SCAN_TIMEOUT",
  COMPLETED: "COMPLETED",
  ADMIN_CANCELLED: "ADMIN_CANCELLED",
  // รถปิดงาน (ทุกแผงจบ) ก่อน Worker คนนี้ Scan เข้างาน — ไม่ได้ทำงานจริง assignment จึงถูกปิดเป็น CANCELLED ไม่ใช่ COMPLETED
  CLOSED_BEFORE_SCAN: "CLOSED_BEFORE_SCAN",
} as const;

export type WorkerAssignmentEventType =
  (typeof WORKER_ASSIGNMENT_EVENT_TYPE)[keyof typeof WORKER_ASSIGNMENT_EVENT_TYPE];

export interface WorkerAssignmentEventWriteInput {
  assignment_id: number;
  worker_id: number;
  vehicle_job_id: number;
  event_type: WorkerAssignmentEventType;
  occurred_at?: Date;
  metadata?: Record<string, unknown> | null;
}
