export interface AdminAuditWorkerPerformanceQuery {
  worker_code?: string;
  date_from?: string;
  date_to?: string;
  page: number;
  limit: number;
  sort_by?:
    | "accept_rate"
    | "total_assigned"
    | "accepted"
    | "accept_timeout"
    | "scan_timeout"
    | "completed"
    | "admin_cancelled"
    | "worker_code";
  sort_order?: "asc" | "desc";
}

export interface AdminAuditWorkerPerformanceRecord {
  worker_code: string;
  full_name: string;
  total_assigned_job_count: number;
  accepted_job_count: number;
  accept_timeout_job_count: number;
  scan_timeout_job_count: number;
  completed_job_count: number;
  admin_cancelled_job_count: number;
  accept_rate: string | null;
}

export interface AdminAuditWorkerPerformanceResponse {
  period: {
    date_from: string;
    date_to: string;
    timezone: "Asia/Bangkok";
  };
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
  data: AdminAuditWorkerPerformanceRecord[];
}

/* -------------------------------------- Audit Events -------------------------------------- */

export const ADMIN_AUDIT_ACTOR_TYPE_VALUES = [
  "system",
  "admin",
  "worker",
  "driver",
  "vendor",
  "gate",
] as const;

export type AdminAuditActorType = (typeof ADMIN_AUDIT_ACTOR_TYPE_VALUES)[number];

export type AdminAuditQuickFilter =
  | "has_vehicle"
  | "system"
  | "critical"
  | "admin"
  | "has_reason";

export interface AdminAuditEventsQuery {
  search?: string;
  actor_type?: AdminAuditActorType;
  event_type?: string;
  date_from?: string;
  date_to?: string;
  quick_filter?: AdminAuditQuickFilter;
  page: number;
  limit: number;
}

export interface AdminAuditEventItem {
  event_id: string;
  event_type: string;
  actor_type: AdminAuditActorType;
  actor_id: string | null;
  vehicle_job_id: string | null;
  market_job_id: string | null;
  ticket_id: string | null;
  assignment_id: string | null;
  worker_id: string | null;
  reason_code: string | null;
  reason_text: string | null;
  metadata: Record<string, unknown> | null;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  occurred_at: string;
}

export interface AdminAuditEventsSummary {
  unique_vehicle_count: number;
  with_reason_count: number;
  actor_type_counts: Record<string, number>;
  event_type_counts: Record<string, number>;
}

export interface AdminAuditEventsResponse {
  data: AdminAuditEventItem[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
  summary: AdminAuditEventsSummary;
}

/* -------------------------------------- Audit Events: Raw Source Rows -------------------------------------- */

export interface AdminAuditTicketJobRow {
  id: number;
  ticket_number: string;
  created_at: string;
  work_started_at: string | null;
  completed_at: string | null;
}

export interface AdminAuditGateRequestLogRow {
  id: number;
  vehicle_job_id: number | null;
  market_job_id: number | null;
  gate_transaction_ref: string;
  ticket_number: string | null;
  ticket_no: string | null;
  market_code: string | null;
  market_name: string | null;
  created_at: string;
}

export interface AdminAuditDriverSessionRow {
  id: number;
  vehicle_job_id: number;
  ticket_number: string | null;
  created_at: string;
}

export interface AdminAuditWorkerAssignmentEventRow {
  id: number;
  assignment_id: number;
  worker_id: number;
  vehicle_job_id: number;
  event_type: string;
  occurred_at: string;
  metadata: Record<string, unknown> | null;
  worker_code: string | null;
  worker_full_name: string | null;
  ticket_number: string | null;
}

export interface AdminAuditCompletionSubmissionRow {
  id: number;
  ticket_id: number;
  assignment_id: number | null;
  submitted_by_account_id: number | null;
  submitted_by_worker_id: number | null;
  submitted_by_role: string;
  submitted_by_code: string | null;
  submitted_by_full_name: string | null;
  created_at: string;
  rejected_at: string | null;
  confirmed_at: string | null;
  resolved_by_line_user_id: string | null;
  booth_code: string | null;
  booth_name: string | null;
  market_job_id: number | null;
  ticket_no: string | null;
  vehicle_job_id: number | null;
  ticket_number: string | null;
}

export interface AdminAuditTicketRatingRow {
  id: number;
  ticket_id: number;
  submission_id: number;
  line_user_id: string;
  target_type: string | null;
  score: number;
  rated_at: string;
  booth_code: string | null;
  booth_name: string | null;
  market_job_id: number | null;
  ticket_no: string | null;
  vehicle_job_id: number | null;
  ticket_number: string | null;
}

export interface AdminAuditMessageDeliveryLogRow {
  id: number;
  channel: string;
  job_name: string;
  target: string | null;
  status: string;
  sent_at: string | null;
  failed_at: string | null;
}

export interface AdminAuditActionLogRow {
  vehicle_ticket_number: string | null;
  market_ticket_no: string | null;
  gate_ticket_booth_code: string | null;
}
