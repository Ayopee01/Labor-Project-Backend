export const WORKER_ASSIGNMENT_EVENT_TYPE = {
  ASSIGNED: "ASSIGNED",
  ACCEPTED: "ACCEPTED",
  ACCEPT_TIMEOUT: "ACCEPT_TIMEOUT",
  SCANNED: "SCANNED",
  SCAN_TIMEOUT: "SCAN_TIMEOUT",
  COMPLETED: "COMPLETED",
  ADMIN_CANCELLED: "ADMIN_CANCELLED",
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
