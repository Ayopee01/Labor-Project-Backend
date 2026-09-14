// Import Library
import type { NextFunction, Request, Response } from "express";
import type { PlainObject } from "../types/shared/common.type";

/* -------------------------------------- Config -------------------------------------- */

// Config mapping ของ key request ที่เป็น PascalCase ให้แปลงเป็น snake_case สำหรับ service/repository
const requestKeyMap: Record<string, string> = {
  AccessToken: "access_token",
  AccountId: "account_id",
  ActiveDevice: "active_device",
  AdminCode: "admin_code",
  AcceptedAt: "accepted_at",
  AcceptDeadlineAt: "accept_deadline_at",
  AcceptDeadlineUnixMs: "accept_deadline_unix_ms",
  ActorType: "actor_type",
  ActorId: "actor_id",
  ActorName: "actor_name",
  ActorTypeCounts: "actor_type_counts",
  AndroidDownloadUrl: "android_download_url",
  AssignedStalls: "assigned_stalls",
  AssignmentId: "assignment_id",
  AssignmentIds: "assignment_ids",
  AssignmentStatus: "assignment_status",
  AvailableDropoffPoints: "available_dropoff_points",
  AvailablePackages: "available_packages",
  AvailableProducts: "available_products",
  AvailableShifts: "available_shifts",
  AvailableWorkerCodes: "available_worker_codes",
  BreakCountLimit: "break_count_limit",
  BreakCountUsed: "break_count_used",
  BreakUntil: "break_until",
  BreakUntilUnixMs: "break_until_unix_ms",
  BuildNumber: "build_number",
  BusinessDate: "business_date",
  CancelledAt: "cancelled_at",
  CancelledByType: "cancelled_by_type",
  CancelledByName: "cancelled_by_name",
  ClientId: "client_id",
  ClientSecret: "client_secret",
  CoatNo: "coat_no",
  CompanyShareRate: "company_share_rate",
  CompletedAt: "completed_at",
  CompletedJobCount: "completed_job_count",
  ConfirmedByType: "confirmed_by_type",
  ConfirmedQuantity: "confirmed_quantity",
  ConfirmedQuantityTotal: "confirmed_quantity_total",
  ConfirmedStalls: "confirmed_stalls",
  ConfirmationStatus: "confirmation_status",
  CorrectionOwner: "correction_owner",
  CorrectionOwnerType: "correction_owner_type",
  CurrentPassword: "current_password",
  CanSkip: "can_skip",
  DateFrom: "date_from",
  DateTo: "date_to",
  DeviceId: "device_id",
  DeviceName: "device_name",
  DispatchNow: "dispatch_now",
  DownloadUrl: "download_url",
  DropoffPoint: "dropoff_point",
  DurationSeconds: "duration_seconds",
  DriverQrToken: "driver_qr_token",
  DriverSessionToken: "driver_session_token",
  DriverSessionTtlHours: "driver_session_ttl_hours",
  DuplicateField: "duplicate_field",
  EmployeeCode: "employee_code",
  EndTime: "end_time",
  EventId: "event_id",
  EventType: "event_type",
  EventTypeCounts: "event_type_counts",
  ExpiresAt: "expires_at",
  ExpiresIn: "expires_in",
  FcmToken: "fcm_token",
  FinalStatus: "final_status",
  ForceUpdate: "force_update",
  ForceUpdateAt: "force_update_at",
  ForceUpdateNotificationSentAt: "force_update_notification_sent_at",
  FullName: "full_name",
  GateTransactionRef: "gate_transaction_ref",
  HistoryStatus: "history_status",
  HistoryFlags: "history_flags",
  ImageUrl: "image_url",
  IosDownloadUrl: "ios_download_url",
  LaborColor: "labor_color",
  LaborFeeTotal: "labor_fee_total",
  LatestActiveAt: "latest_active_at",
  LatestActivityAt: "latest_activity_at",
  LicensePlate: "license_plate",
  LicensePlateProvince: "license_plate_province",
  LoginChallengeToken: "login_challenge_token",
  MarketCode: "marketCode",
  MarketName: "marketName",
  MarketJobId: "market_job_id",
  NewPassword: "new_password",
  NotificationKey: "notification_key",
  OccurredAt: "occurred_at",
  OperationStatus: "operation_status",
  OriginalPackageCode: "original_package_code",
  PackageCode: "packageCode",
  PackageName: "packageName",
  PaymentStatus: "payment_status",
  PermissionLevel: "permission_level",
  PlateNo: "plate_no",
  PlateProvince: "plate_province",
  ProductCode: "productCode",
  ProductFullCode: "productFullCode",
  ProductCount: "product_count",
  ProductName: "productName",
  QrToken: "qr_token",
  QueuePosition: "queue_position",
  ReleasedWorkerCodes: "released_worker_codes",
  ReleasedAt: "released_at",
  PreviousQuantity: "previous_quantity",
  RefreshToken: "refresh_token",
  RejectReason: "reject_reason",
  RejectionHistory: "rejection_history",
  RejectedByType: "rejected_by_type",
  RejectedByName: "rejected_by_name",
  ReleaseAt: "release_at",
  ReleaseMessage: "release_message",
  ReleaseNotes: "release_notes",
  ReleaseNotificationAt: "release_notification_at",
  ReleaseNotificationSentAt: "release_notification_sent_at",
  RemainingBreakTime: "remaining_break_time",
  ReasonCode: "reason_code",
  ReasonText: "reason_text",
  ReadyNow: "ready_now",
  RowCount: "row_count",
  ActualQuantity: "actual_quantity",
  ScanDeadlineAt: "scan_deadline_at",
  ScanDeadlineUnixMs: "scan_deadline_unix_ms",
  ScannedAt: "scanned_at",
  ScannedTicketNo: "scanned_ticket_no",
  ScanStatus: "scan_status",
  ServerTime: "server_time",
  ServerTimeUnixMs: "server_time_unix_ms",
  ShiftActive: "shift_active",
  ShirtNumber: "shirt_number",
  ShirtType: "shirt_type",
  ShiftName: "shift_name",
  SocketConnected: "socket_connected",
  StallFeeTotal: "stall_fee_total",
  StartTime: "start_time",
  StartedAt: "started_at",
  StatusCode: "statusCode",
  StallCount: "stall_count",
  SubmissionStatus: "submission_status",
  SubmittedAt: "submitted_at",
  SubmittedByCodes: "submitted_by_codes",
  SubmittedByRole: "submitted_by_role",
  LatestSubmittedByCode: "latest_submitted_by_code",
  LatestSubmittedByName: "latest_submitted_by_name",
  SubmissionWorkerSnapshot: "submission_worker_snapshot",
  SubmittedCompleteAt: "submitted_complete_at",
  TargetRef: "target_ref",
  TargetType: "target_type",
  TicketCreatedAt: "ticket_created_at",
  TicketNumber: "ticket_number",
  TicketNo: "ticket_no",
  TimeIn: "time_in",
  TimeOut: "time_out",
  TimeWork: "time_work",
  TodayJobCount: "today_job_count",
  TokenType: "token_type",
  TotalPages: "total_pages",
  TotalSeconds: "total_seconds",
  TotalWorkerShare: "total_worker_share",
  UpdatedAt: "updated_at",
  CreatedAt: "created_at",
  UniqueVehicleCount: "unique_vehicle_count",
  UpdateAvailable: "update_available",
  UserId: "user_id",
  ValidationErrors: "validation_errors",
  VehicleJob: "vehicle_job",
  VehicleJobId: "vehicle_job_id",
  VendorLineId: "vendor_line_id",
  WaitUnload: "wait_unload",
  WaitWorker: "wait_worker",
  WithReasonCount: "with_reason_count",
  WorkerAccountId: "worker_id",
  WorkerAccountIds: "worker_ids",
  WorkerId: "worker_id",
  WorkerAction: "worker_action",
  WorkerAcceptDeadlineSeconds: "worker_accept_deadline_seconds",
  WorkerAcceptTimeoutLimit: "worker_accept_timeout_limit",
  WorkerBreakCountTtlHours: "worker_break_count_ttl_hours",
  WorkerBreakDurationMinutes: "worker_break_duration_minutes",
  WorkerBreakLimit: "worker_break_limit",
  WorkerCode: "worker_code",
  WorkerCodes: "worker_codes",
  WorkerPresenceStaleSeconds: "worker_presence_stale_seconds",
  WorkerScanDeadlineMinutes: "worker_scan_deadline_minutes",
  WorkerScanTeamRemainingMinutes: "worker_scan_team_remaining_minutes",
  WorkerScanWarningBeforeMinutes: "worker_scan_warning_before_minutes",
  WorkersRequired: "workers_required",
  CheckedInCount: "checked_in_count",
  AcceptedCount: "accepted_count",
  VendorConfirmTimeoutHours: "vendor_confirm_timeout_hours",
  VendorReconfirmTimeoutHours: "vendor_reconfirm_timeout_hours",
  WorkDate: "work_date",
  WorkSchedule: "work_schedule",
  WorkStartDate: "work_start_date",
  WorkStartedAt: "work_started_at",
  WorkStartedAtUnixMs: "work_started_at_unix_ms",

  FinalAmount: "final_amount",
  MembershipStatus: "membership_status",
  TicketId: "ticket_id",
  TotalAmount: "total_amount",
  TotalEarnings: "total_earnings",

  BoothCount: "booth_count",
  BoothCode: "boothCode",
  FinalStallAmount: "final_stall_amount",
  FinancialStatus: "financial_status",
  FinancializedBoothCount: "financialized_booth_count",
  FinalizedAt: "finalized_at",
  FundAmount: "fund_amount",
  LaborFeeRaw: "labor_fee_raw",
  LaborRateSnapshot: "labor_rate_snapshot",
  PackageWeightSnapshot: "package_weight_snapshot",
  ProductCharge: "product_charge",
  RateIdSnapshot: "rate_id_snapshot",
  RateMarketCode: "rate_market_code",
  RateSnapshot: "rate_snapshot",
  RateSnapshotAt: "rate_snapshot_at",
  RateSource: "rate_source",
  RawAmount: "raw_amount",
  RemainderAmount: "remainder_amount",
  SourceRateIdSnapshot: "source_rate_id_snapshot",
  StallFeeRaw: "stall_fee_raw",
  StallFeeRounded: "stall_fee_rounded",
  StallRateSnapshot: "stall_rate_snapshot",
  TicketProductId: "ticket_product_id",
  TicketWorkerId: "ticket_worker_id",
  VehicleType: "vehicle_type",
  WeightMaxSnapshot: "weight_max_snapshot",
  WeightMinSnapshot: "weight_min_snapshot",
  WeightRangeName: "weight_range_name",
  WorkerCount: "worker_count",
  WorkerPayoutTotal: "worker_payout_total",
  WorkerToQueue: "worker_to_queue",
  WorkerToOpenapp: "worker_to_openapp",
};

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจสอบว่า value เป็น plain object หรือไม่ (ไม่ใช่ array, function, class instance, null, undefined)
function isPlainObject(value: unknown): value is PlainObject {
  return Object.prototype.toString.call(value) === "[object Object]";
}

// Function เพิ่มตัวอักษรแรกเป็นพิมพ์เล็กตอนสร้าง key response แบบ camelCase
function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

// Function เพิ่มตัวอักษรแรกเป็นพิมพ์ใหญ่ตอนสร้าง key response แบบ PascalCase
function capitalize(value: string): string {
  if (!value) {
    return value;
  }

  return value.charAt(0).toUpperCase() + value.slice(1);
}

// Function แปลง key เป็น PascalCase สำหรับ public API response
export function toPascalCaseKey(key: string): string {
  if (!key.includes("_") && /^[A-Z]/.test(key)) {
    return key;
  }

  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((part) => capitalize(part.toLowerCase()))
    .join("");
}

// Function แปลง key เป็น snake_case สำหรับ service/repository
function normalizeRequestKey(key: string): string {
  if (requestKeyMap[key]) {
    return requestKeyMap[key];
  }

  if (/^[A-Z]/.test(key)) {
    return lowerFirst(key);
  }

  return key;
}

// Function แปลง object key แบบ recursive สำหรับ array, plain object, และ primitive value
function transformObjectKeys(
  value: unknown,
  keyTransformer: (key: string) => string
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => transformObjectKeys(item, keyTransformer));
  }

  if (value instanceof Date || !isPlainObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      keyTransformer(key),
      transformObjectKeys(entryValue, keyTransformer),
    ])
  );
}

// Function แปลง request payload เป็น snake_case สำหรับ service/repository
export function normalizeApiRequestPayload(value: unknown): unknown {
  return transformObjectKeys(value, normalizeRequestKey);
}

// Function แปลง response payload เป็น PascalCase สำหรับ public API response
export function toPascalCasePayload(value: unknown): unknown {
  return transformObjectKeys(value, toPascalCaseKey);
}

// Function เพิ่ม server_time และ server_time_unix_ms ให้ response payload สำหรับ public API response
function withServerTime(body: unknown): unknown {
  if (!isPlainObject(body)) {
    return body;
  }

  const now = new Date();

  return {
    ...body,
    server_time: now.toISOString(),
    server_time_unix_ms: now.getTime(),
  };
}

// Function ตรวจสอบว่า request path เป็น path ที่ไม่ต้องแปลง case หรือไม่ (เช่น /api-docs, /uploads, /storage)
function shouldSkipCaseMiddleware(req: Request): boolean {
  return req.path.startsWith("/api-docs") || req.path.startsWith("/uploads") || req.path.startsWith("/storage");
}

// Function normalize request body สำหรับ public API request โดยแปลง key เป็น snake_case สำหรับ service/repository
export function normalizeApiRequestBody(
  req: Request,
  _res: Response,
  next: NextFunction
): void {
  const isBoothJobRequest =
    req.method === "POST" && req.path === "/api/gate/tickets";

  if (!isBoothJobRequest && !shouldSkipCaseMiddleware(req) && req.body !== undefined) {
    req.body = normalizeApiRequestPayload(req.body);
  }

  next();
}

// Function pascalCase response body สำหรับ public API response โดยแปลง key เป็น PascalCase และเพิ่ม server_time, server_time_unix_ms
export function pascalCaseApiResponse(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (shouldSkipCaseMiddleware(req)) {
    next();
    return;
  }

  const originalJson = res.json.bind(res);

  res.json = ((body: unknown) =>
    originalJson(toPascalCasePayload(withServerTime(body)))) as Response["json"];
  next();
}
