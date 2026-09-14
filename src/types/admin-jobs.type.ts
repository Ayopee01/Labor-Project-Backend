import type { Prisma } from "@prisma/client";
import type { DAILY_WORKER_INCOME_PAYMENT_STATUS, VEHICLE_OPERATION_STATUS } from "../constants/status";

// Type record สำหรับบอร์ด operation ของ TicketJob
export type TicketJobOperationRecord = Prisma.TicketJobGetPayload<{
  include: {
    marketJobs: {
      include: {
        tickets: {
          include: {
            products: true;
          };
        };
      };
    };
    assignments: {
      include: {
        worker: true;
      };
    };
  };
}>;

export type AdminTicketJobFinancialRecord = Prisma.TicketJobGetPayload<{
  include: {
    marketJobs: {
      include: {
        ticketWorkers: {
          include: {
            worker: true;
            payments: true;
          };
        };
        tickets: {
          include: {
            products: {
              include: {
                financial: {
                  include: {
                    workerPayments: {
                      include: {
                        ticketWorker: {
                          include: {
                            worker: true;
                          };
                        };
                      };
                    };
                  };
                };
              };
            };
          };
        };
      };
    };
  };
}>;

// Type record สำหรับอ่าน Work History แบบละเอียดของ TicketJob จาก DB
export type AdminTicketJobHistoryRecord = Prisma.TicketJobGetPayload<{
  include: {
    marketJobs: {
      include: {
        ticketWorkers: {
          include: {
            worker: true;
            payments: true;
          };
        };
        tickets: {
          include: {
            completionSubmissions: {
              include: {
                submittedByAccount: true;
                submittedByWorker: true;
                workerSnapshots: {
                  include: {
                    ticketWorker: {
                      include: {
                        worker: true;
                      };
                    };
                  };
                };
              };
            };
            products: {
              include: {
                financial: {
                  include: {
                    workerPayments: {
                      include: {
                        ticketWorker: {
                          include: {
                            worker: true;
                          };
                        };
                      };
                    };
                  };
                };
              };
            };
          };
        };
      };
    };
    assignments: {
      include: {
        worker: true;
        events: true;
      };
    };
  };
}>;

// Type สถานะ Financial ระดับ TicketJob
export type AdminTicketJobFinancialStatus =
  | "PENDING"
  | "PARTIAL"
  | "FINALIZED";

// Type snapshot rate ที่ใช้คำนวณเงินจริงของ Product
export interface AdminFinancialRateSnapshotResponse {
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
}

// Type ยอดเงินจริงของ Worker ต่อ Product
export interface AdminFinancialWorkerPaymentResponse {
  ticket_worker_id: number;
  worker_code: string;
  full_name: string;
  membership_status: string;
  raw_amount: string;
  remainder_amount: string;
  final_amount: string;
}

// Type Financial ที่ persist แล้วต่อ Product
export interface AdminProductFinancialResponse {
  stall_fee_raw: string;
  stall_fee_rounded: string;
  labor_fee_raw: string;
  product_charge: string;
  worker_count: number;
  worker_payout_total: string;
  fund_amount: string;
  finalized_at: string;
}

// Type Product breakdown สำหรับ Admin
export interface AdminFinancialProductResponse {
  ticket_product_id: number;
  productCode: string;
  productFullCode: string | null;
  productName: string;
  packageCode: string;
  packageName: string;
  quantity: string;
  confirmed_quantity: string | null;
  rate_snapshot: AdminFinancialRateSnapshotResponse;
  financial: AdminProductFinancialResponse | null;
  workers: AdminFinancialWorkerPaymentResponse[];
}

// Typeยอดรวม Worker ต่อ Booth
export interface AdminFinancialBoothWorkerResponse {
  ticket_worker_id: number;
  worker_code: string;
  full_name: string;
  membership_status: string;
  total_amount: string;
}

// Type Booth breakdown สำหรับ Admin
export interface AdminFinancialBoothResponse {
  ticket_id: number;
  ticket_no: string;
  marketCode: string;
  marketName: string;
  boothCode: string;
  boothName: string | null;
  status: string;
  financialized: boolean;
  final_stall_amount: string | null;
  completed_at: string | null;
  summary: {
    labor_fee_raw: string;
    worker_payout_total: string;
    fund_amount: string;
  };
  workers: AdminFinancialBoothWorkerResponse[];
  products: AdminFinancialProductResponse[];
}

// Type response Financial breakdown ระดับ TicketJob
export interface AdminTicketJobFinancialResponse {
  vehicle_job: {
    ticket_number: string;
    license_plate: string;
    license_plate_province: string | null;
    vehicle_type: string | null;
    status: string;
  };
  financial_status: AdminTicketJobFinancialStatus;
  summary: {
    booth_count: number;
    financialized_booth_count: number;
    final_stall_amount: string;
    labor_fee_raw: string;
    worker_payout_total: string;
    fund_amount: string;
  };
  booths: AdminFinancialBoothResponse[];
}

export type HistoryStatusFilter = "ALL" | "COMPLETED" | "CANCELLED" | "REJECT_PENDING";

export type HistoryStatusValue = "COMPLETED" | "CANCELLED" | "REJECT_PENDING";

export const HISTORY_FLAG_VALUES = [
  "FINANCE_CALCULATED",
  "WORKERS_RELEASED",
  "BOOTH_REJECTED",
  "AUTO_CONFIRMED",
  "WORKER_CHANGED_DURING_JOB",
  "SUBMISSION_ROSTER_INCOMPLETE",
  "ADMIN_SUBMITTED_ON_BEHALF",
  "VEHICLE_CANCELLED_AFTER_START",
  "VEHICLE_CANCELLED_BEFORE_START",
] as const;

export type HistoryFlagValue = (typeof HISTORY_FLAG_VALUES)[number];

export interface TicketJobListFilters {
  search?: string;
  status?: string;
  history_status?: HistoryStatusFilter;
  dropoff_point?: string;
  startAt?: Date;
  endAt?: Date;
  page?: number;
  limit?: number;
}

// Type ค่า operation_status สำหรับ filter บอร์ด operation ของ Admin
export type VehicleOperationStatus =
  (typeof VEHICLE_OPERATION_STATUS)[keyof typeof VEHICLE_OPERATION_STATUS];

// Type filter สำหรับบอร์ด operation ของ Admin แยกจาก filter ของ history
export interface TicketJobOperationFilters {
  search?: string;
  operation_status?: VehicleOperationStatus;
  dropoff_point?: string;
  startAt?: Date;
  endAt?: Date;
  page?: number;
  limit?: number;
}

export interface TicketJobHistoryListResult {
  data: AdminTicketJobHistoryRecord[];
  total?: number;
  available_dropoff_points: string[];
}

export interface AdminTicketJobListItemResponse {
  ticket_number: string;
  plate_no: string;
  plate_province: string | null;
  vehicle_type: string | null;
  workers_required: number;
  dispatch_now: boolean;
  status: string;
}

interface AdminTicketJobTimestampedVehicleResponse extends AdminTicketJobListItemResponse {
  created_at: string;
  updated_at: string;
}

// Type แถวสินค้าใน response history และ operation ของ Admin
interface AdminTicketJobHistoryProductResponse {
  productCode: string;
  productName: string;
  packageCode: string;
  packageName: string;
  quantity: string;
  confirmed_quantity: string | null;
}

// Type แถว booth/ticket ที่แสดงใน response history และ operation ของ Admin
interface AdminTicketJobHistoryTicketResponse {
  boothCode: string;
  boothName: string | null;
  vendor_line_id: string | null;
  reject_reason: string | null;
  status: string;
  confirmation_status: string;
  created_at: string;
  updated_at: string;
  products: AdminTicketJobHistoryProductResponse[];
}

// Type แถว Business Ticket (market job) ที่รวม booth ใน history งานรถของ Admin
interface AdminTicketJobHistoryMarketResponse {
  ticket_no: string;
  marketCode: string;
  marketName: string;
  dropoff_point: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  booths: AdminTicketJobHistoryTicketResponse[];
}

export interface AdminHistoryRejectionResponse {
  rejectedAt: string;
  correction_owner: string | null;
  correction_owner_type: "worker" | "admin";
  rejected_by_type: "owner" | "member" | null;
  rejected_by_name: string | null;
}

export interface AdminHistorySubmissionWorkerResponse {
  worker_code: string | null;
  full_name: string;
}

export type AdminHistoryProductResponse = Omit<AdminFinancialProductResponse, "ticket_product_id">;

export interface AdminHistoryBoothResponse
  extends Omit<AdminFinancialBoothResponse, "ticket_id" | "ticket_no" | "marketCode" | "marketName" | "products"> {
  products: AdminHistoryProductResponse[];
  vendor_line_id: string | null;
  submitted_by_codes: string[];
  submitted_by_role: "worker" | "admin" | null;
  latest_submitted_by_code: string | null;
  latest_submitted_by_name: string | null;
  submission_worker_snapshot: AdminHistorySubmissionWorkerResponse[];
  submitted_at: string | null;
  confirmedAt: string | null;
  confirmed_by_type: "vendor" | "timeout" | null;
  rejection_history: AdminHistoryRejectionResponse[];
  company_share_rate: string;
  worker_count: number | null;
  cancellation: AdminHistoryCancellationResponse | null;
}

// Type แถว Business Ticket (market job) ใน Work History แบบละเอียด
export interface AdminHistoryMarketResponse {
  ticket_no: string;
  marketCode: string;
  marketName: string;
  dropoff_point: string | null;
  status: string;
  cancellation: AdminHistoryCancellationResponse | null;
  booths: AdminHistoryBoothResponse[];
}

export interface AdminHistoryCancellationResponse {
  cancelled_at: string | null;
  reason_code: string | null;
  reason_text: string | null;
  cancelled_by_type: string | null;
  cancelled_by_name: string | null;
}

export interface AdminHistoryWorkerResponse {
  worker_id: number;
  assignment_id: number;
  worker_code: string | null;
  full_name: string;
  labor_color: string | null;
  shirt_number: string | null;
  accepted_at: string | null;
  scanned_at: string | null;
  started_at: string | null;
  submitted_at: string | null;
  released_at: string | null;
  final_status: string;
  cancellation: AdminHistoryCancellationResponse | null;
}

// Type รายการ Timeline หนึ่งเหตุการณ์ของ TicketJob
export interface AdminHistoryTimelineItemResponse {
  type: string;
  occurred_at: string;
  actor_type: "worker" | "admin" | "system";
  actor_name: string | null;
  description: string;
}

// Type สรุป Finance ระดับ TicketJob ทั้งคัน (รวมทุก Business Ticket) — Reuse ค่าที่ Finalize แล้ว
export interface AdminHistoryFinanceResponse {
  stall_fee_total: string;
  labor_fee_total: string;
  total_worker_share: string;
  fund_amount: string;
  worker_count: number;
  workers: Array<{
    worker_id: number;
    worker_code: string | null;
    full_name: string;
    total_amount: string;
  }>;
}

// Type item ใน response history งานรถของ Admin
export interface AdminTicketJobHistoryItemResponse {
  vehicle_job: AdminTicketJobListItemResponse & {
    ticket_created_at: string | null;
    work_started_at: string | null;
    submitted_complete_at: string | null;
    completed_at: string | null;
    duration_seconds: number | null;
    history_status: HistoryStatusValue | null;
    history_flags: HistoryFlagValue[];
    cancellation: AdminHistoryCancellationResponse | null;
  };
  markets: AdminHistoryMarketResponse[];
  workers: AdminHistoryWorkerResponse[];
  timeline: AdminHistoryTimelineItemResponse[];
  finance: AdminHistoryFinanceResponse;
}

// Type จำนวนสถานะสำหรับ list ด้านซ้ายของบอร์ด operation ฝั่ง Admin
export interface AdminTicketJobOperationSummaryResponse {
  total: number;
  ready_now: number;
  wait_unload: number;
  wait_worker: number;
  working: number;
  completed: number;
  cancelled: number;
  reject: number;
}

// Type จำนวน assignment ของ worker ในงานรถหนึ่งงานบนบอร์ด operation ของ Admin
export interface AdminTicketJobOperationWorkerSummaryResponse {
  required: number;
  assigned: number;
  active: number;
  accepted: number;
  scanned: number;
  working: number;
  delivered: number;
  rejected: number;
  completed: number;
  cancelled: number;
  timeout: number;
  missing: number;
}

// Type จำนวน market/booth/product ของงานรถหนึ่งงานบนบอร์ด operation ของ Admin
export interface AdminTicketJobOperationMarketSummaryResponse {
  total: number;
  stalls: number;
  products: number;
  delivered: number;
  confirmed: number;
  rejected: number;
}

// Type แถว worker ที่แสดงในรายละเอียด operation ของรถหนึ่งงาน
interface AdminTicketJobOperationWorkerResponse {
  worker_code: string | null;
  full_name: string;
  labor_color: string | null;
  shirt_number: string | null;
  image_url: string | null;
  shift_name: string | null;
  assignment_status: string;
  worker_status: string;
  accept_deadline_at: string | null;
  accept_deadline_unix_ms?: number | null;
  scan_deadline_at: string | null;
  scan_deadline_unix_ms?: number | null;
  accepted_at: string | null;
  scanned_at: string | null;
  completed_at: string | null;
  released_at: string | null;
  created_at: string;
  updated_at: string;
}

// Type แถว booth/ticket พร้อมจำนวนสินค้าในรายละเอียด operation ของ Admin
interface AdminTicketJobOperationTicketResponse
  extends AdminTicketJobHistoryTicketResponse {
  product_count: number;
}

// Type แถว market พร้อม summary ในรายละเอียด operation ของ Admin
export interface AdminTicketJobOperationMarketResponse
  extends AdminTicketJobHistoryMarketResponse {
  summary: {
    stalls: number;
    products: number;
    delivered: number;
    confirmed: number;
    rejected: number;
  };
  booths: AdminTicketJobOperationTicketResponse[];
}

// Type ข้อมูลเต็มของงานรถหนึ่งงานบนบอร์ด operation
export interface AdminTicketJobOperationItemResponse {
  operation_status: VehicleOperationStatus;
  vehicle_job: AdminTicketJobTimestampedVehicleResponse & {
    dispatch_now: boolean;
  };
  worker_summary: AdminTicketJobOperationWorkerSummaryResponse;
  market_summary: AdminTicketJobOperationMarketSummaryResponse;
  scan_summary: {
    required: number;
    scanned: number;
    remaining: number;
  };
  timing: {
    gate_elapsed_seconds: number;
    working_elapsed_seconds: number | null;
  };
  workers: AdminTicketJobOperationWorkerResponse[];
  markets: AdminTicketJobOperationMarketResponse[];
}

// Type response แบบ list สำหรับบอร์ด operation ของ Admin
export interface AdminTicketJobOperationListResponse {
  server_time: string;
  summary: AdminTicketJobOperationSummaryResponse;
  data: AdminTicketJobOperationItemResponse[];
  available_dropoff_points: string[];
  pagination?: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
}

export interface AdminScanDeadlineAssignmentResponse {
  worker_code: string | null;
  status: string;
  scan_deadline_at: string | null;
  scan_deadline_unix_ms: number | null;
}

// ไม่มี QR/barcode เดี่ยวให้ส่งเพราะ check-in เป็นระดับ Business Ticket (scan ticket_no ใบไหนก็ได้)
export interface AdminExtendScanDeadlineResponse {
  message: string;
  ticket_number: string;
  assignments: AdminScanDeadlineAssignmentResponse[];
}

export interface AdminAssignmentResponse {
  ticket_number: string;
  worker_code: string | null;
  status: string;
  accept_deadline_at: string | null;
  accept_deadline_unix_ms: number | null;
  scan_deadline_at: string | null;
  scan_deadline_unix_ms: number | null;
  created_at: string;
  updated_at: string;
}

export interface AdminAssignWorkersResponse {
  message: string;
  ticket_number: string;
  assignments: AdminAssignmentResponse[];
}

export interface AdminCancelAssignmentResponse {
  message: string;
  ticket_number: string | null;
  worker_code: string | null;
  status: string;
}

export interface AdminCancelTicketJobAndRequeueResponse {
  message: string;
  ticket_number: string;
  status: string;
  worker_to_queue: Array<string | null>;
  worker_to_openapp: Array<string | null>;
}

// Type response หลังยกเลิกงาน market (Business Ticket) หนึ่งรายการ
export interface AdminMarketJobActionResponse {
  message: string;
  ticket_number: string | null;
  ticket_no: string;
  marketCode: string;
  status: string;
}

// Type response หลังยกเลิกงาน booth/ticket หนึ่งรายการ
export interface AdminStallJobActionResponse {
  message: string;
  ticket_number: string | null;
  ticket_no: string | null;
  marketCode: string | null;
  boothCode: string;
  status: string;
  confirmation_status: string;
}

// Type response หลังยกเลิก Worker หนึ่งคนออกจาก Business Ticket ใบเดียว
export interface AdminCancelTicketWorkerResponse {
  message: string;
  ticket_number: string;
  ticket_no: string;
  worker_code: string;
  status: string;
}

// Type response หลังถอด Worker หนึ่งคนออกจากแค่ Booth เดียว
export interface AdminCancelTicketWorkerFromBoothResponse {
  message: string;
  ticket_number: string;
  ticket_no: string;
  boothCode: string;
  worker_code: string;
  status: string;
  booth_cancelled: boolean;
}

// Type response ของเส้นยกเลิกรวม (POST /vehicle-jobs/assignment/cancel)
export type AdminTicketJobAssignmentCancelResponse =
  | AdminCancelTicketJobAndRequeueResponse
  | AdminMarketJobActionResponse
  | AdminStallJobActionResponse
  | AdminCancelAssignmentResponse
  | AdminCancelTicketWorkerResponse
  | AdminCancelTicketWorkerFromBoothResponse;

// Type แถวสินค้าที่ Admin แก้/ส่งยอดแทน Worker หนึ่งรายการ
export interface AdminOverrideCountItemResponse {
  productCode: string;
  packageCode: string;
  previous_quantity: string | null;
  confirmed_quantity: string | null;
}

// Type response หลัง Admin แก้/ส่งยอดสินค้าแทน Worker ของ Booth หนึ่งใบ
export interface AdminOverrideCountResponse {
  message: string;
  ticket_number: string;
  boothCode: string;
  status: string;
  reason_code: string;
  reason_text: string | null;
  products: AdminOverrideCountItemResponse[];
}

// Type response หลัง Admin สั่งให้ TicketJob กลับไปสถานะ WAIT
export interface AdminVehicleWaitResponse {
  message: string;
  ticket_number: string;
  status: string;
  dispatch_now: boolean;
  worker_to_queue: Array<string | null>;
  worker_to_openapp: Array<string | null>;
  reason_code: string;
  reason_text: string | null;
}

// Type response หลัง Admin ปล่อย Worker ทั้งทีมของ TicketJob กลับคิวก่อนเวลา
export interface AdminReleaseWorkersResponse {
  message: string;
  ticket_number: string;
  released_worker_codes: Array<string | null>;
  reason_code: string;
  reason_text: string | null;
}

/* -------------------------------------- Daily Worker Income -------------------------------------- */

// Type record สำหรับอ่านรายได้ Worker รายวันจาก DB — หนึ่งแถว = สมาชิกภาพของ Worker หนึ่งคนใน
export type DailyWorkerIncomeRecord = Prisma.TicketWorkerGetPayload<{
  include: {
    worker: true;
    marketJob: {
      include: {
        ticketJob: {
          include: {
            assignments: {
              include: {
                worker: true;
              };
            };
            adminActionLogs: {
              include: {
                actor: true;
              };
            };
          };
        };
        tickets: {
          include: {
            completionSubmissions: true;
            adminActionLogs: {
              include: {
                actor: true;
              };
            };
          };
        };
        adminActionLogs: {
          include: {
            actor: true;
          };
        };
      };
    };
  };
}>;

export interface DailyWorkerIncomeFilters {
  workerCode?: string;
  status?: string;
  shift?: string;
  startAt?: Date;
  endAt?: Date;
  search?: string;
  page?: number;
  limit?: number;
}

export interface DailyWorkerIncomeWorkerResponse {
  code: string | null;
  name: string;
  shirt_number: string | null;
}

export interface DailyWorkerIncomeCancellationResponse {
  cancelled_at: string | null;
  cancelled_by_type: string | null;
  cancelled_by_name: string | null;
}

export type DailyWorkerIncomePaymentStatus =
  (typeof DAILY_WORKER_INCOME_PAYMENT_STATUS)[keyof typeof DAILY_WORKER_INCOME_PAYMENT_STATUS];

// Type แถวรายได้ Worker รายวันหนึ่งแถว (หนึ่ง Worker หนึ่ง Business Ticket) 
export interface DailyWorkerIncomeItemResponse {
  worker: DailyWorkerIncomeWorkerResponse;
  accepted_at: string | null;
  shift: string | null;
  ticket_no: string;
  plate: string;
  payable: string;
  scanned_at: string | null;
  started_at: string | null;
  submitted_at: string | null;
  confirmedAt: string | null;
  released_at: string | null;
  payment_status: DailyWorkerIncomePaymentStatus;
  cancellation: DailyWorkerIncomeCancellationResponse | null;
  riskText: string;
}

/* -------------------------------------- Daily Stall Fee -------------------------------------- */

// Type record สำหรับอ่านรายงานค่าลงสินค้าแผงค้ารายวันจาก DB — หนึ่งแถว = หนึ่ง TicketProductFinancial
export type DailyStallFeeRecord = Prisma.TicketProductFinancialGetPayload<{
  include: {
    product: {
      include: {
        ticket: {
          include: {
            marketJob: {
              include: {
                ticketJob: true;
              };
            };
          };
        };
      };
    };
  };
}>;

export interface DailyStallFeeFilters {
  startAt: Date;
  endAt: Date;
  search?: string;
  productCode?: string;
  packageCode?: string;
  page: number;
  limit: number;
}

export interface DailyStallFeeSummary {
  row_count: number;
  stall_count: number;
  confirmed_quantity_total: Prisma.Decimal;
  stall_fee_total: Prisma.Decimal;
}

export interface DailyStallFeeProductOption {
  product_code: string;
  product_name: string;
}

export interface DailyStallFeePackageOption {
  package_code: string;
  package_name: string;
}

// Type ผลลัพธ์ดิบจาก repository — service เป็นคนแปลง Decimal/Date เป็น string ตาม response contract
export interface DailyStallFeeQueryResult {
  data: DailyStallFeeRecord[];
  total: number;
  summary: DailyStallFeeSummary;
  available_products: DailyStallFeeProductOption[];
  available_packages: DailyStallFeePackageOption[];
}

export interface DailyStallFeeItemResponse {
  id: number;
  business_date: string;
  finalized_at: string;
  booth_code: string;
  plate: string;
  plate_province: string | null;
  ticket_no: string;
  market_code: string;
  market_name: string;
  product_code: string;
  product_full_code: string | null;
  product_name: string;
  package_code: string;
  package_name: string;
  confirmed_quantity: string;
  stall_fee_rounded: string;
}

export interface DailyStallFeeListResponse {
  data: DailyStallFeeItemResponse[];
  summary: {
    row_count: number;
    stall_count: number;
    confirmed_quantity_total: string;
    stall_fee_total: string;
  };
  available_products: DailyStallFeeProductOption[];
  available_packages: DailyStallFeePackageOption[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
}

/* -------------------------------------- Monthly Stall Fee -------------------------------------- */

export interface MonthlyStallFeeFilters {
  startAt: Date;
  endAt: Date;
  marketSearch?: string;
  boothSearch?: string;
  shirtColor?: string;
  page: number;
  limit: number;
}

// Type แถวดิบจาก raw SQL aggregation (GROUP BY market_code + booth_code + shirt_color) — ต้องใช้ raw
export interface MonthlyStallFeeGroupRow {
  market_code: string;
  market_name: string;
  booth_code: string;
  shirt_color: string;
  financial_item_count: number;
  debit_amount: Prisma.Decimal;
}

export interface MonthlyStallFeeSummary {
  row_count: number;
  stall_count: number;
  financial_item_count: number;
  debit_amount_total: Prisma.Decimal;
}

export interface MonthlyStallFeeMarketOption {
  market_code: string;
  market_name: string;
}

export interface MonthlyStallFeeStallOption {
  market_code: string;
  booth_code: string;
}

// Type ผลลัพธ์ดิบจาก repository — service เป็นคนแปลง Decimal เป็น string และประกอบ id ตาม response contract
export interface MonthlyStallFeeQueryResult {
  data: MonthlyStallFeeGroupRow[];
  total: number;
  summary: MonthlyStallFeeSummary;
  available_markets: MonthlyStallFeeMarketOption[];
  available_stalls: MonthlyStallFeeStallOption[];
  available_shirt_colors: string[];
}

export interface MonthlyStallFeeItemResponse {
  id: string;
  market_code: string;
  market_name: string;
  booth_code: string;
  shirt_color: string;
  financial_item_count: number;
  debit_amount: string;
}

export interface MonthlyStallFeeListResponse {
  period: {
    date_from: string;
    date_to: string;
  };
  data: MonthlyStallFeeItemResponse[];
  summary: {
    row_count: number;
    stall_count: number;
    financial_item_count: number;
    debit_amount_total: string;
  };
  available_markets: MonthlyStallFeeMarketOption[];
  available_stalls: MonthlyStallFeeStallOption[];
  available_shirt_colors: string[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
}
