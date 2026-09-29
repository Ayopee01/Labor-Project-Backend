// Config ประเภท Admin action ที่บันทึกลง admin_action_logs สำหรับ Audit + Work History Timeline
export const ADMIN_ACTION_TYPE = {
  OVERRIDE_COUNT: "OVERRIDE_COUNT",
  VEHICLE_WAIT: "VEHICLE_WAIT",
  WORKERS_RELEASED: "WORKERS_RELEASED",
  ASSIGNMENT_CANCELLED: "ASSIGNMENT_CANCELLED",
  SCAN_DEADLINE_EXTENDED: "SCAN_DEADLINE_EXTENDED",
  MARKET_JOB_CANCELLED: "MARKET_JOB_CANCELLED",
  VEHICLE_JOB_CANCELLED: "VEHICLE_JOB_CANCELLED",
  STALL_JOB_CANCELLED: "STALL_JOB_CANCELLED",
  TICKET_WORKER_CANCELLED: "TICKET_WORKER_CANCELLED",
  TICKET_WORKER_CANCELLED_FROM_BOOTH: "TICKET_WORKER_CANCELLED_FROM_BOOTH",
  WORKER_STATUS_FORCED: "WORKER_STATUS_FORCED",
  MANUAL_ASSIGNMENT: "MANUAL_ASSIGNMENT",
} as const;

// Type ประเภท admin action
export type AdminActionType =
  (typeof ADMIN_ACTION_TYPE)[keyof typeof ADMIN_ACTION_TYPE];

// Type ส่วน DTO ของ admin action log
export interface AdminActionLogDto {
  id: number;
  // null เมื่อ action ไม่เกี่ยวกับงานรถ (เช่น force สถานะ worker ที่ว่างงาน)
  vehicle_job_id: number | null;
  gate_ticket_id: number | null;
  market_job_id: number | null;
  action_type: AdminActionType;
  reason_code: string | null;
  reason_text: string | null;
  actor_account_id: number;
  // username ของ Admin ที่ทำรายการ
  actor_username: string | null;
  actor_full_name: string | null;
  actor_role: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

// Type ส่วน Repository input สำหรับบันทึก admin action log
export interface AdminActionLogWriteInput {
  vehicle_job_id?: number | null;
  gate_ticket_id?: number | null;
  market_job_id?: number | null;
  action_type: AdminActionType;
  reason_code?: string | null;
  reason_text?: string | null;
  actor_account_id: number;
  metadata?: Record<string, unknown> | null;
}
