import { Prisma } from "@prisma/client";

export type AccountRecord = {
  id: number;
  username: string;
  password_hash: string;
  role: "admin" | "worker";
  status: string;
  full_name: string;
  position?: string | null;
  email?: string | null;
  phone?: string | null;
  image_url?: string | null;
  permission_level?: string | null;
  lang: string;
  created_at?: string;
  updated_at?: string;
  // Field ต่อไปนี้มีไว้เฉพาะ "shadow" ของ worker ใน authAccountsById สำหรับ mock ส่วนที่ยังไม่ได้
  // migrate ไป MasterWorker เต็มรูปแบบ (admin-jobs/admin-audit — รอ Phase 3) ลบทิ้งได้เมื่อ Phase 3
  // ย้าย mock สองไฟล์นั้นไปอ่าน state.workers (MasterWorkerRecord) โดยตรงแทน
  shirt_number?: string | null;
  time_work?: string | null;
};

// Worker master data — คู่ขนานของ AccountRecord แต่สำหรับ Worker (ไม่มี Account record อีกต่อไป)
// Field เป็น snake_case ตรงกับ MasterWorkerDto จริง (mock ส่วนใหญ่ในไฟล์นี้คืน record ตรงๆ แทน DTO)
export type MasterWorkerRecord = {
  id: number;
  labor_code: string;
  password_hash: string | null;
  status: number | null;
  full_name: string | null;
  telephone?: string | null;
  nationality?: string | null;
  labor_color?: string | null;
  coat_no?: string | null;
  picture?: string | null;
  image_url?: string | null;
  work_start_date?: string | null;
  time_work?: string | null;
  time_in?: string | null;
  time_out?: string | null;
  lang: string;
  source: "master_sync" | "admin_created";
  created_at?: string;
  updated_at?: string;
};

export type WorkerNotificationRecord = {
  id: number;
  worker_id: number;
  type: string;
  notification_key: string | null;
  lang: string;
  title: string;
  message: string;
  payload: unknown;
  read_at: string | null;
  created_at: string;
  updated_at: string;
};

export type GateClientRecord = {
  id: number;
  client_id: string;
  name: string;
  secret_hash: string;
  status: "active" | "inactive";
  last_used_at: string | null;
  created_by: number | null;
  updated_by: number | null;
  created_at: string;
  updated_at: string;
};

export type MobileAppVersionRecord = {
  id: number;
  version: string;
  build_number: number;
  release_at: string | null;
  android_download_url: string | null;
  ios_download_url: string | null;
  force_update_at: string | null;
  release_notification_at: string | null;
  release_notification_sent_at: string | null;
  force_update_notification_sent_at: string | null;
  release_message: string | null;
  release_notes: string | null;
  created_by: number | null;
  updated_by: number | null;
  created_at: string;
  updated_at: string;
};

export type AssignmentRecord = {
  id: number;
  vehicle_job_id: number;
  worker_id: number;
  status: string;
  accept_deadline_at: string | null;
  scan_deadline_at: string | null;
  accepted_at?: string | null;
  scanned_at?: string | null;
  completed_at?: string | null;
  released_at?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type WorkerAssignmentEventRecord = {
  id: number;
  assignment_id: number;
  worker_id: number;
  vehicle_job_id: number;
  event_type: string;
  occurred_at: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export type TicketJobRecord = {
  id: number;
  ticket_number: string;
  license_plate: string;
  license_plate_province: string | null;
  vehicle_type: string | null;
  workers_required: number;
  removed_after_scan_count?: number;
  dispatch_now: boolean;
  status: string;
  work_started_at?: string | null;
  driver_qr_token: string;
  expected_ticket_count?: number | null;
  tickets_closed_at?: string | null;
  completed_at?: string | null;
  created_at: string;
  updated_at: string;
};

// Business Ticket (repurposed MarketJob) — หนึ่งใบอยู่ได้ตลาดเดียว แต่ TicketNumber
// (TicketJobRecord) เดียวมีได้หลาย MarketJobRecord
export type MarketJobRecord = {
  id: number;
  vehicle_job_id: number;
  ticket_no: string;
  ticket_created_at: string;
  booth_count: number;
  gate_transaction_ref: string;
  workers_required: number;
  marketCode: string;
  marketName: string;
  dropoff_point: string | null;
  status: string;
  worker_roster_locked_at: string | null;
  final_stall_amount: string | null;
  financialized_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
};

export type BoothJobRecord = {
  id: number;
  vehicle_job_id: number;
  market_job_id: number;
  marketCode?: string;
  marketName?: string;
  dropoff_point?: string | null;
  boothCode: string;
  boothName: string | null;
  vendor_line_id: string | null;
  reject_reason: string | null;
  status: string;
  confirmation_status: string | null;
  final_stall_amount?: string | null;
  completed_at?: string | null;
  financialized_at?: string | null;
  created_at?: string;
  updated_at?: string;
};

export type WorkerCheckinLogRecord = {
  id: number;
  workerId: number;
  workerCode: string;
  shiftInstanceKey: string;
  timeWork: string;
  timeIn: string;
  timeOut: string;
  firstOnlineAt: string | null;
  lastOnlineAt: string | null;
  offlineAt: string | null;
  closedAt: string | null;
  closeReason: string | null;
  acceptTimeoutStreak: number;
  lastAcceptTimeoutAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WorkerBreakLogRecord = {
  id: number;
  workerCheckinLogId: number;
  startedAt: string;
  scheduledEndAt: string;
  endedAt: string | null;
  endReason: string | null;
  createdAt: string;
  updatedAt: string;
};

export type TicketProductRecord = {
  id: number;
  ticket_id: number;
  productCode: string;
  productFullCode: string | null;
  productName: string;
  packageCode: string;
  packageName: string;
  quantity: string;
  confirmed_quantity: string | null;
  package_weight_snapshot: string | null;
  rate_id_snapshot: number | null;
  source_rate_id_snapshot: number | null;
  rate_market_code: string | null;
  rate_source: string | null;
  weight_range_name: string | null;
  weight_min_snapshot: string | null;
  weight_max_snapshot: string | null;
  stall_rate_snapshot: string | null;
  labor_rate_snapshot: string | null;
  rate_snapshot_at: string | null;
  created_at?: string;
  updated_at?: string;
};

// Worker Roster ของ Business Ticket (market job) — ไม่ใช่ระดับ Booth อีกต่อไป
export type TicketWorkerRecord = {
  id: number;
  market_job_id: number;
  worker_id: number;
  status: string;
  final_earning_amount?: string | null;
  joined_at: string;
  cancelled_at: string | null;
  completed_at: string | null;
};

export type TicketProductFinancialRecord = {
  id: number;
  ticket_product_id: number;
  confirmed_quantity: string;
  stall_fee_raw: string;
  stall_fee_rounded: string;
  labor_fee_raw: string;
  product_charge: string;
  worker_count: number;
  worker_payout_total: string;
  fund_amount: string;
  finalized_at: string;
  shirt_color_snapshot?: string | null;
};

export type TicketWorkerPaymentRecord = {
  id: number;
  ticket_product_financial_id: number;
  ticket_worker_id: number;
  raw_amount: string;
  remainder_amount: string;
  final_amount: string;
};

// Snapshot ของ TicketWorker ที่ยัง WORKING ณ ตอนแผง (gate ticket) นี้ confirm — ใช้เป็นตัวหารเงิน
// ของแผงนั้นโดยเฉพาะตอน finalize แทน roster สุดท้ายของทั้ง Business Ticket
export type BoothJobWorkerSnapshotRecord = {
  id: number;
  gate_ticket_id: number;
  ticket_worker_id: number;
  created_at: string;
};

export type BoothJobWorkerExclusionRecord = {
  id: number;
  gate_ticket_id: number;
  ticket_worker_id: number;
  cancelled_at: string;
};

export type SubmissionWorkerSnapshotRecord = {
  id: number;
  submission_id: number;
  ticket_worker_id: number;
  created_at: string;
};

export type TicketCompletionSubmissionRecord = {
  id: number;
  ticket_id: number;
  submitted_by_account_id?: number | null;
  submitted_by_worker_id?: number | null;
  // Defaults to "worker" in the mock builder when omitted — matches every pre-existing fixture
  // that predates Admin being able to submit on behalf.
  submitted_by_role?: string;
  status: string;
  confirmed_at: string | null;
  rejected_at: string | null;
  reject_reason?: string | null;
  resolved_by_line_user_id: string | null;
  worker_count_snapshot?: number | null;
  // TicketJobAssignment the submitting worker was actively working under at submit time. Null
  // for admin-submitted-on-behalf rows and for fixtures that predate this feature.
  assignment_id?: number | null;
  created_at?: string;
};

export type TicketRatingRecord = {
  id: number;
  ticket_id: number;
  submission_id: number;
  line_user_id: string;
  target_type: string | null;
  score: number;
  rated_at: string;
  created_at: string;
  updated_at: string;
};

export type LineActionTokenRecord = {
  id: number;
  token: string;
  action: string;
  ticket_id: number;
  submission_id: number;
  boothCode: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
  updated_at: string;
};

export type GateRequestLogRecord = {
  id: number;
  gate_transaction_ref: string;
  vehicle_job_id: number | null;
  market_job_id: number | null;
  payload_snapshot: unknown;
  response_snapshot: unknown | null;
  created_at: string;
};

export type DriverSessionRecord = {
  id: number;
  vehicle_job_id: number;
  device_id: string | null;
  session_token: string;
  expires_at: string;
  revoked_at: string | null;
  read_only_until: string | null;
  created_at: string;
  updated_at: string;
};

export type MessageDeliveryLogRecord = {
  id: number;
  channel: string;
  job_name: string;
  target: string | null;
  status: string;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
};

export type MasterProductRecord = {
  id: number;
  productCode: string;
  productFullCode: string;
  productName: string;
  packageCode: string;
  packageName: string;
  packageWeight: number;
  range: unknown;
  status: string;
};

export type MasterRateRecord = {
  id: number;
  sourceRateId: number;
  marketCode: string;
  weightRangeName: string;
  weightMin: Prisma.Decimal;
  weightMax: Prisma.Decimal;
  stallRate: Prisma.Decimal;
  laborRate: Prisma.Decimal;
  status: number;
};

export type MasterMarketRecord = {
  id: number;
  marketCode: string;
  marketName: string | null;
  boothCode: string;
  boothName: string;
  marketStatus: string | null;
  boothStatus: string;
};

export type MasterOwnerStallRecord = {
  id: number;
  marketCode: string;
  boothCode: string;
  cardId: string;
  firstName: string | null;
  lastName: string | null;
  ownerStatus: string | null;
  lineUserId: string | null;
  status: string;
};

export type MasterMemberStallRecord = {
  id: number;
  ownerLineUserId: string;
  ownerIdCard: string;
  marketCode: string;
  memberStallLineUserId: string;
  memberStallFirstName: string | null;
  memberStallLastName: string | null;
  memberStallStatusOnStall: string | null;
  status: string;
};

export type AdminActionLogRecord = {
  id: number;
  vehicle_job_id: number | null;
  gate_ticket_id: number | null;
  market_job_id: number | null;
  action_type: string;
  reason_code: string | null;
  reason_text: string | null;
  actor_account_id: number;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

export type SecurityAuditLogRecord = {
  id: number;
  event_type: string;
  outcome: string;
  actor_type: string | null;
  actor_account_id: number | null;
  actor_worker_id: number | null;
  actor_username: string | null;
  actor_full_name: string | null;
  session_id: number | null;
  request_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  failure_code: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};
