// Import Types
import type { WorkerWorkStatus } from "./shared/worker-status.type";
import type { WebSocket } from "ws";
import type { WorkScheduleDto } from "./admin-workers.type";

/* -------------------------------------- Types -------------------------------------- */

// Type payload ของ delayed job สำหรับ assignment timeout และ vendor auto-confirm
export type AssignmentTimeoutJobData = {
  assignmentId?: number;
  workerId?: number;
  ticketId?: number;
  submissionId?: number;
  mobileAppVersionId?: number;
  kind?:
    | "accept"
    | "scan"
    | "scan_warning"
    | "vendor_confirm"
    | "mobile_app_release_notification"
    | "mobile_app_force_update_notification";
};

// Type payload ของ delayed job สำหรับพักและจบกะ worker
export type WorkerScheduleJobData = {
  workerId: number;
  scheduleId: number;
  shiftInstanceKey?: string;
  kind?: "break_return" | "shift_end";
};

// Type การเปลี่ยนคิวที่ต้องทำหลัง accept-timeout ตัดสินใจแล้ว — แยกจาก AssignmentAcceptTimeoutResult
// เพื่อให้ผู้เรียกเป็นคนสั่ง Redis เอง "หลัง" commit ทรานแซกชัน DB เสมอ ไม่ใช่ระหว่างทรานแซกชันยังเปิดอยู่
export type AssignmentTimeoutQueueAction = "requeue" | "open_app";

// Type ผลลัพธ์เมื่อ worker ไม่ accept งานจน timeout
export type AssignmentAcceptTimeoutResult = {
  queue_action: AssignmentTimeoutQueueAction;
  reason: string;
  timeout_count: number;
  timeout_limit: number;
  closed_shift: boolean;
};

// Type ผลลัพธ์เมื่อ worker จบงานและอาจกลับเข้าคิวได้
export type CompletedWorkerQueueResult = {
  vehicle_job: Pick<TicketJobDto, "ticket_number">;
  completed_worker_ids: number[];
};

// Type ผลลัพธ์เมื่องานรถจบครบทั้งคัน
export type CompletedTicketJobResult = {
  vehicle_job: TicketJobDto;
  completed_assignment_ids: number[];
  completed_worker_ids: number[];
};

// Type WebSocket ของ worker พร้อมข้อมูล worker ที่ผูกไว้
export type WorkerSocket = WebSocket & {
  workerId?: number;
  isAlive?: boolean;
};

// Type payload ทั่วไปที่ส่งผ่าน Worker WebSocket
export type WorkerSocketPayload = Record<string, unknown>;

// Type option สำหรับกำหนดว่าจะส่ง FCM push คู่กับ WebSocket หรือไม่
export type WorkerSocketEventOptions = {
  push?: boolean;
  notificationKey?: string | null;
  notificationParams?: Record<string, unknown>;
  fallbackTitle?: string;
  fallbackMessage?: string;
};

// Type ค่า reason สำหรับปิด attendance ของ worker
export type WorkerShiftCloseReason =
  | "worker_offline"
  | "worker_logout"
  | "admin_session_revoked"
  | "shift_ended"
  | "assignment_timeout_limit_reached"
  | "ticket_delivered_after_shift_end";

// Type key หลักสำหรับหา attendance ของ worker ในหนึ่งกะ
export type WorkerCheckinLogKeyInput = {
  worker_id: number;
  shift_instance_key: string;
};

// Type input สำหรับบันทึก attendance ของ worker ในหนึ่งกะ
export type WorkerCheckinLogWriteInput = WorkerCheckinLogKeyInput & {
  worker_code: string;
  schedule: WorkScheduleDto;
};

// Type ค่า reason ที่ทำให้การพักของ worker หนึ่งครั้งจบลง
export type WorkerBreakEndReason =
  | "auto_timeout"
  | "early_return"
  | "shift_closed";

// Type input สำหรับเริ่มบันทึก break log หนึ่งครั้ง
export type WorkerBreakLogStartInput = WorkerCheckinLogKeyInput & {
  scheduled_end_at: Date;
};

// Type input สำหรับปิด break log ที่ยังเปิดอยู่ล่าสุดของกะนั้น
export type WorkerBreakLogCloseInput = WorkerCheckinLogKeyInput & {
  end_reason: WorkerBreakEndReason;
};

// Type DTO ของ vehicle_jobs (TicketNumber) ที่ใช้ใน Worker flow
export interface TicketJobDto {
  id: number;
  ticket_number: string;
  license_plate: string;
  license_plate_province: string | null;
  vehicle_type: string | null;
  workers_required: number;
  dispatch_now: boolean;
  status: string;
  work_started_at: string | null;
  driver_qr_token: string;
  expected_ticket_count: number | null;
  tickets_closed_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

// Type DTO ของ market_jobs (Business Ticket) ที่อยู่ใต้ vehicle job
export interface MarketJobDto {
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
}

// Type DTO ของ ticket/booth ที่อยู่ใต้ market job
export interface BoothJobDto {
  id: number;
  vehicle_job_id: number;
  market_job_id: number;
  boothCode: string;
  boothName: string | null;
  vendor_line_id: string | null;
  reject_reason: string | null;
  status: string;
  confirmation_status: string;
  final_stall_amount: string | null;
  completed_at: string | null;
  financialized_at: string | null;
  created_at: string;
  updated_at: string;
}

// Type LINE target ของเจ้าของแผงหรือสมาชิกแผงที่ต้องรับแจ้งเตือน
export interface VendorLineTargetDto {
  line_user_id: string;
  target_type: "owner" | "member";
}

// Type ticket ปัจจุบันที่ worker ต้องส่งยอดต่อ
export interface CurrentTicketProgressDto {
  ticket: BoothJobDto;
  marketCode: string;
  marketName: string;
}

// Type สรุปความพร้อมของ worker หลัง scan QR
export interface VehicleWorkReadinessDto {
  workers_required: number;
  checked_in_count: number;
  remaining_count: number;
  is_ready: boolean;
}

// Type DTO ของสินค้าภายใต้ ticket
export interface TicketProductDto {
  id: number;
  ticket_id: number;
  productCode: string;
  productName: string;
  packageCode: string;
  packageName: string;
  quantity: string;
  confirmed_quantity: string | null;
  created_at: string;
  updated_at: string;
}

// Type response รายการ PackageCode ที่ยังใช้งานอยู่ของ ProductCode เดียว — ใช้ให้ Worker เลือก
export interface WorkerProductPackageOptionsResponse {
  ProductCode: string;
  ProductName: string;
  Packages: Array<{
    PackageCode: string;
    PackageName: string;
    PackageWeight: number;
  }>;
}

// Type DTO ความสัมพันธ์ระหว่าง Business Ticket (market job) กับ worker
export interface TicketWorkerDto {
  id: number;
  market_job_id: number;
  worker_id: number;
  status: string;
  final_earning_amount: string | null;
  joined_at: string;
  cancelled_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

// Type DTO การส่งยอด (โดย Worker เองหรือ Admin ส่งแทน) ที่รอ vendor confirm/reject
export interface TicketCompletionSubmissionDto {
  id: number;
  ticket_id: number;
  submitted_by_account_id: number | null;
  submitted_by_worker_id: number | null;
  submitted_by_role: string;
  status: string;
  confirmed_at: string | null;
  rejected_at: string | null;
  reject_reason: string | null;
  resolved_by_line_user_id: string | null;
  worker_count_snapshot: number | null;
  assignment_id: number | null;
  created_at: string;
  updated_at: string;
}

// Type DTO สถานะคิวของ worker
export interface WorkerQueueEntryDto {
  id: number;
  worker_id: number;
  status: WorkerWorkStatus;
  ready_at: string | null;
  break_until: string | null;
  break_count_used?: number;
  break_count_limit?: number;
  created_at: string;
  updated_at: string;
}

// Type response แบบสั้นของการ online/offline worker
export interface WorkerOnlineResponse {
  statusCode: number;
  code: string;
  message: string;
}

// Type response เมื่อ worker เข้าพักสำเร็จ
export interface WorkerBreakResponse {
  full_name: string;
  worker_code: string | null;
  status: WorkerWorkStatus;
  break_count_used: number;
  break_count_limit: number;
}

// Type ข้อมูลกะใน response status ของ worker
interface WorkerStatusShift {
  name: string;
  start_time: string;
  end_time: string;
}

// Type เวลาพักที่เหลือใน response status ของ worker
interface WorkerStatusRemainingBreakTime {
  total_seconds: number;
  minutes: number;
  seconds: number;
  text: string;
}

// Type response ปัจจุบันของ worker สำหรับหน้า status
export interface WorkerStatusResponse {
  full_name: string;
  worker_code: string | null;
  image_url: string | null;
  status: WorkerWorkStatus;
  today_job_count: number;
  break_count_used: number;
  completed_job_count: number;
  nationality: string | null;
  work_start_date: string | null;
  phone: string | null;
  shift: WorkerStatusShift | null;
  shift_active: boolean;
  current_job?: WorkerCurrentJobResponse | null;
  break_until?: string;
  break_until_unix_ms?: number | null;
  remaining_break_time?: WorkerStatusRemainingBreakTime;
}

// Type สถานะการเชื่อมต่อ socket ของ worker สำหรับ Admin
export interface WorkerPresenceDto {
  is_online: boolean;
  last_seen_at: string | null;
  stale_after_seconds: number;
}

// Type DTO assignment ของ worker ต่อ vehicle job
export interface TicketJobAssignmentDto {
  id: number;
  vehicle_job_id: number;
  worker_id: number;
  status: string;
  accept_deadline_at: string | null;
  scan_deadline_at: string | null;
  accepted_at: string | null;
  scanned_at: string | null;
  completed_at: string | null;
  released_at: string | null;
  created_at: string;
  updated_at: string;
}

// Type DTO ประวัติ assignment พร้อมข้อมูลงานรถและรายได้จริง
export interface WorkerAssignmentHistoryItemDto {
  assignment: TicketJobAssignmentDto;
  vehicle_job: TicketJobDto;
  markets: WorkerAssignmentHistoryMarketDto[];
}

// Type response ประวัติ assignment ที่ส่งให้ Worker Mobile
export interface WorkerAssignmentHistoryItemResponse {
  ticket_number: string;
  ticket_completed_at: string | null;
  license_plate: string;
  license_plate_province: string | null;
  status: string;
  markets: WorkerAssignmentHistoryMarketDto[];
}

export interface WorkerAssignmentHistoryProductDto {
  productCode: string;
  productName: string;
  packageCode: string;
  packageName: string;
  confirmed_quantity: string | null;
}

export interface WorkerAssignmentHistoryBoothDto {
  boothCode: string;
  boothName: string | null;
  status: string;
  confirmation_status: string;
  completed_at: string | null;
  confirmed_at: string | null;
  products: WorkerAssignmentHistoryProductDto[];
  rating: number | null;
}

export interface WorkerAssignmentHistoryMarketDto {
  ticket_no: string;
  marketCode: string;
  marketName: string;
  booths: WorkerAssignmentHistoryBoothDto[];
}

export interface WorkerAssignmentHistoryResponse {
  date: string;
  summary: {
    job_count: number;
    accept_timeout_job_count: number;
    completed_job_count: number;
  };
  pagination?: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
  data: WorkerAssignmentHistoryItemResponse[];
}

// Type สมาชิกทีมที่แสดงตอน worker รับงาน
export interface WorkerAssignmentTeamMemberDto {
  worker_id?: number;
  full_name: string;
  worker_code: string | null;
  coat_no?: string | null;
  image_url: string | null;
  scan_status: string;
  accepted_at?: string | null;
  scanned_at?: string | null;
}

// Type แถวดิบจาก Repository ก่อนคำนวณ scan_status — ให้ Service เป็นคนตัดสิน scan_status เอง
export interface WorkerAssignmentTeamRawMemberDto {
  worker_id?: number;
  full_name: string;
  worker_code: string | null;
  coat_no?: string | null;
  image_url: string | null;
  status: string;
  completed_at: string | null;
  accepted_at?: string | null;
  scanned_at?: string | null;
}

// Type สมาชิกทีมใน response ที่ส่งให้ Worker Mobile (ชื่อ field ตาม public API contract)
export interface WorkerAssignmentTeamMemberResponse {
  worker_id?: number;
  full_name: string;
  worker_code: string | null;
  shirt_number: string | null;
  image_url: string | null;
  scan_status: string;
  accepted_at?: string | null;
  scanned_at?: string | null;
}

export interface WorkerCurrentJobProductResponse {
  productCode: string;
  productName: string;
  packageCode: string;
  packageName: string;
  quantity: string;
  confirmed_quantity: string | null;
}

export interface WorkerCurrentJobBoothResponse {
  boothCode: string;
  boothName: string | null;
  status: string;
  confirmation_status: string;
  completed_at: string | null;
  products: WorkerCurrentJobProductResponse[];
}

export interface WorkerCurrentJobMarketResponse {
  ticket_no: string;
  created_at: string;
  marketCode: string;
  marketName: string;
  booths: WorkerCurrentJobBoothResponse[];
}

export interface WorkerCurrentJobTeamMemberResponse {
  shirt_number: string | null;
  image_url: string | null;
  full_name: string;
  scan_status: "scanned" | "not_scanned";
  scanned_at: string | null;
}

export interface WorkerCurrentJobTeamScanResponse {
  workers_required: number;
  checked_in_count: number;
  remaining_count: number;
  is_ready: boolean;
}

// Type สรุปว่าตอนนี้มีคน Accept งานนี้แล้วกี่คนจากที่ต้องการทั้งหมด (ก่อนจะถึงขั้นตอน scan QR)
export interface WorkerCurrentJobTeamAcceptResponse {
  workers_required: number;
  accepted_count: number;
  remaining_count: number;
  is_ready: boolean;
}

export interface WorkerCurrentJobResponse {
  scanned_ticket_no: string | null;
  ticket_number: string;
  license_plate: string;
  license_plate_province: string | null;
  accept_created_at: string;
  accept_deadline_at: string | null;
  accept_deadline_unix_ms: number | null;
  scan_deadline_at: string | null;
  scan_deadline_unix_ms: number | null;
  work_started_at: string | null;
  work_started_at_unix_ms: number | null;
  vehicle_type: string | null;
  team_accept: WorkerCurrentJobTeamAcceptResponse;
  team_scan: WorkerCurrentJobTeamScanResponse;
  markets: WorkerCurrentJobMarketResponse[];
  team: WorkerCurrentJobTeamMemberResponse[];
}

// Type สินค้าใน assignment ที่ worker ต้องเห็น
interface WorkerAssignmentProductDto {
  productCode: string;
  productName: string;
  quantity: string;
  packageName: string;
}

// Type แผงใน assignment ที่ worker ต้องไปส่งยอด
interface WorkerAssignmentStallDto {
  boothCode: string;
  boothName: string | null;
  product_count: number;
  products: WorkerAssignmentProductDto[];
}

// Type ตลาดใน assignment ที่รวมแผงของตลาดนั้น (หนึ่งรายการ = หนึ่ง Business Ticket)
interface WorkerAssignmentMarketDto {
  ticket_no: string;
  created_at: string;
  marketName: string;
  stall_count: number;
  stalls: WorkerAssignmentStallDto[];
}

// Type response หลัง worker accept งาน
export interface WorkerAssignmentAcceptResponse {
  ticket_number: string;
  worker_code: string | null;
  shirt_number: string | null;
  accepted_at: string | null;
  license_plate: string;
  license_plate_province: string | null;
  scan_deadline_at: string | null;
  scan_deadline_unix_ms: number | null;
  team_accept: WorkerCurrentJobTeamAcceptResponse;
  team: WorkerAssignmentTeamMemberResponse[];
  markets: WorkerAssignmentMarketDto[];
}

// Type response หลัง worker scan QR check-in
export interface WorkerAssignmentCheckInResponse {
  status: string;
  worker_status: WorkerWorkStatus;
  worker_code: string | null;
  ticket_number: string;
  ticket_no: string;
  team_scan: WorkerCurrentJobTeamScanResponse;
}

export interface WorkerEarningsSummaryResponse {
  period: {
    from_date: string;
    to_date: string;
    day_count: number;
  };
  total_earnings: string;
  daily: Array<{
    date: string;
    earnings: string;
  }>;
  details: Array<{
    completed_at: string;
    ticket_number: string;
    ticket_no: string;
    license_plate: string;
    license_plate_province: string | null;
    booth_count: number;
    marketCode: string;
    marketName: string;
    earnings: string;
  }>;
}

// Type response รายละเอียดงานรถพร้อม Business Ticket, แผง และสินค้า
export interface TicketJobDetailResponse {
  vehicle_job: TicketJobDto;
  markets: Array<
    MarketJobDto & {
      booths: Array<
        BoothJobDto & {
          products: TicketProductDto[];
        }
      >;
    }
  >;
}

// Type response หลัง worker ส่งยอดให้ vendor ตรวจสอบ
export interface TicketCompletionResponse {
  message: string;
  ticket_number: string | null;
  ticket_no: string | null;
  ticketNos: string[];
  ticket_completed_at: string | null;
  marketCode: string | null;
  marketName: string | null;
  boothCode: string;
  boothName: string | null;
  status: string;
  confirmation_status: string;
  completed_at: string | null;
  confirmed_at: string | null;
  rejected_at: string | null;
  submission_status: string;
  assignment_status: string;
  items: Array<{
    productCode: string;
    productName: string;
    packageCode: string;
    packageName: string;
    quantity: string;
    confirmed_quantity: string | null;
  }>;
}

// Type ค่า Rate Snapshot ใหม่ที่คำนวณจากการเปลี่ยน PackageCode ตอน Worker ส่งยอด — service layer
export interface TicketProductPackageSwitchSnapshot {
  packageName: string;
  packageWeightSnapshot: string;
  rateIdSnapshot: number;
  sourceRateIdSnapshot: number;
  rateMarketCode: string;
  rateSource: string;
  weightRangeName: string;
  weightMinSnapshot: string;
  weightMaxSnapshot: string;
  stallRateSnapshot: string;
  laborRateSnapshot: string;
  rateSnapshotAt: Date;
}

// Type input รายการสินค้าที่ worker ยืนยันจำนวนตอนส่งยอด
export interface TicketProductConfirmationInput {
  productCode: string;
  packageCode: string;
  confirmed_quantity: number;
  original_package_code?: string;
  package_switch?: TicketProductPackageSwitchSnapshot;
}

// Type event ที่ Worker WebSocket ส่งให้ Mobile ได้
export type WorkerSocketEventType =
  | "WORKER_CONNECTED"
  | "WORKER_ASSIGNED"
  | "ASSIGNMENT_TIMEOUT"
  | "ASSIGNMENT_CANCELLED"
  | "ASSIGNMENT_ACCEPTED"
  | "ASSIGNMENT_CHECKED_IN"
  | "ASSIGNMENT_TEAM_UPDATED"
  | "TEAM_READY"
  | "ASSIGNMENT_SCAN_DEADLINE_EXTENDED"
  | "ASSIGNMENT_SCAN_DEADLINE_SHORTENED"
  | "ASSIGNMENT_SCAN_DEADLINE_WARNING"
  | "TICKET_COMPLETION_SUBMITTED"
  | "TICKET_COMPLETION_RESULT"
  | "STALL_JOB_CANCELLED"
  | "MARKET_JOB_CANCELLED"
  | "VEHICLE_JOB_CANCELLED"
  | "SESSION_REVOKED"
  | "WORKER_STATUS_CHANGED";

