// Import Library
import type { Account, AdminActionLog, DriverSession, BoothJob, MarketJob, MasterWorker, TicketCompletionSubmission, TicketProduct, TicketWorker, UserSession, TicketJob, TicketJobAssignment } from "@prisma/client";
// Import Types
import type { SessionDto } from "../../../types/auth.type";
import type { DriverSessionDto } from "../../../types/driver.type";
import type { BoothJobDto, MarketJobDto, TicketCompletionSubmissionDto, TicketProductDto, TicketWorkerDto, TicketJobAssignmentDto, TicketJobDto } from "../../../types/worker.type";
import type { AdminActionLogDto, AdminActionType } from "../../../types/shared/admin-action-log.type";
import { ACCOUNT_ROLES, type AccountDto, type AccountRole, type MasterWorkerDto, type MasterWorkerSource, type SafeAccountDto, type WorkScheduleDto } from "../../../types/admin-workers.type";
import { ACCOUNT_STATUSES, type AccountStatus } from "../../../types/shared/account.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function แปลงวันที่จาก DB เป็น ISO string สำหรับ DTO
function toIsoString(value: Date): string;
function toIsoString(value: string): string;
function toIsoString(value: Date | null): string | null;
function toIsoString(value: Date | string | null): string | null {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
}

// Function แปลงวันที่จาก DB เป็น date string รูปแบบ YYYY-MM-DD
function toDateString(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }

  return value.trim().slice(0, 10);
}

// Function ตัดข้อมูล sensitive ออกจาก account response
export function sanitizeAccount(account: AccountDto): SafeAccountDto;
export function sanitizeAccount(account: null): null;
export function sanitizeAccount(account: AccountDto | null): SafeAccountDto | null {
  if (!account) {
    return null;
  }

  const { password_hash: _passwordHash, ...safeAccount } = account;

  return safeAccount;
}

// Function แปลง role string จาก DB เป็น AccountRole (throw ถ้าไม่รู้จัก)
function toAccountRole(role: string): AccountRole {
  if ((ACCOUNT_ROLES as readonly string[]).includes(role)) {
    return role as AccountRole;
  }

  throw new Error(`Unsupported account role: ${role}`);
}

// Function แปลง status string จาก DB เป็น AccountStatus (throw ถ้าไม่รู้จัก)
function toAccountStatus(status: string): AccountStatus {
  if ((ACCOUNT_STATUSES as readonly string[]).includes(status)) {
    return status as AccountStatus;
  }

  throw new Error(`Unsupported account status: ${status}`);
}

// Function แปลง source string จาก DB เป็น MasterWorkerSource (default เป็น master_sync)
function toMasterWorkerSource(source: string): MasterWorkerSource {
  if (source === "admin_created") {
    return "admin_created";
  }

  return "master_sync";
}

// Function แปลง account (Admin) จาก DB
export function mapAccount(record: Account | null): AccountDto | null {
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    username: record.username,
    password_hash: record.passwordHash,
    role: toAccountRole(record.role),
    status: toAccountStatus(record.status),
    full_name: record.fullName,
    position: record.position,
    email: record.email,
    phone: record.phone,
    image_url: record.imageUrl,
    lang: record.lang,
    permission_level: record.permissionLevel,
    created_by: record.createdBy,
    created_at: toIsoString(record.createdAt),
    updated_at: toIsoString(record.updatedAt),
  };
}

// Function แปลง Picture (Bytes) เป็น base64 string สำหรับ response — ห้ามส่ง Node Buffer object
// ดิบออกไปตรงๆ ตามข้อ 29 ของ worker.md, Frontend เป็นคนประกอบ data URL เอง
function toBase64Picture(value: Uint8Array | null): string | null {
  return value ? Buffer.from(value).toString("base64") : null;
}

// Function แปลง master worker จาก DB
export function mapMasterWorker(record: MasterWorker | null): MasterWorkerDto | null {
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    labor_id: record.laborId,
    labor_code: record.laborCode,
    prefix: record.prefix,
    name: record.name,
    full_name: record.fullName,
    labor_status: record.laborStatus,
    status: record.status,
    work_code: record.workCode,
    nationality: record.nationality,
    telephone: record.telephone,
    work_start_date: record.workStartDate ? toDateString(record.workStartDate) : null,
    labor_color: record.laborColor,
    labor_coat: record.laborCoat,
    coat_no: record.coatNo,
    time_work: record.timeWork,
    time_in: record.timeIn,
    time_out: record.timeOut,
    picture: toBase64Picture(record.picture),
    image_url: record.imageUrl,
    update_date: toIsoString(record.updateDate),
    lang: record.lang,
    source: toMasterWorkerSource(record.source),
    password_hash: record.passwordHash,
    created_at: toIsoString(record.createdAt),
    updated_at: toIsoString(record.updatedAt),
  };
}

// Function แปลง shift assignment ปัจจุบันบน master_workers เป็น schedule DTO เดิม (schedule ไม่ใช่
// entity แยก เก็บเป็น field บน MasterWorker เอง เหมือนที่เคยเป็น Account มาก่อน)
export function mapWorkerSchedule(record: MasterWorker | null): WorkScheduleDto | null {
  if (
    !record ||
    record.timeWork === null ||
    record.timeIn === null ||
    record.timeOut === null
  ) {
    return null;
  }

  return {
    id: record.id,
    worker_id: record.id,
    time_work: record.timeWork,
    work_date: record.workStartDate ? toDateString(record.workStartDate) : toDateString(record.createdAt),
    time_in: record.timeIn,
    time_out: record.timeOut,
    is_current: true,
    created_by: null,
    updated_by: null,
    created_at: toIsoString(record.createdAt),
    updated_at: toIsoString(record.updatedAt),
  };
}

// Function แปลง session (Admin) จาก DB
export function mapSession(record: UserSession | null): SessionDto | null {
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    // accountId การันตีไม่เป็น null เสมอ เพราะ mapSession ใช้กับแถวที่ query ด้วย role: "admin" เท่านั้น
    account_id: record.accountId as number,
    refresh_token_hash: record.refreshTokenHash,
    device_id: record.deviceId,
    device_name: record.deviceName,
    ip_address: record.ipAddress,
    user_agent: record.userAgent,
    is_active: record.isActive,
    last_active_at: toIsoString(record.lastActiveAt),
    expires_at: toIsoString(record.expiresAt),
    revoked_at: toIsoString(record.revokedAt),
    created_at: toIsoString(record.createdAt),
    updated_at: toIsoString(record.updatedAt),
  };
}

// Function แปลง session (Worker) จาก DB ให้เป็น SessionDto shape เดียวกับ mapSession
// เพื่อให้โค้ดที่อ่าน session ใช้ร่วมกันได้ทั้ง Admin และ Worker (account_id คือ MasterWorker.id)
export function mapWorkerSession(record: UserSession | null): SessionDto | null {
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    // workerId การันตีไม่เป็น null เสมอ เพราะ mapWorkerSession ใช้กับแถวที่ query ด้วย role: "worker" เท่านั้น
    account_id: record.workerId as number,
    refresh_token_hash: record.refreshTokenHash,
    device_id: record.deviceId,
    device_name: record.deviceName,
    ip_address: record.ipAddress,
    user_agent: record.userAgent,
    is_active: record.isActive,
    last_active_at: toIsoString(record.lastActiveAt),
    expires_at: toIsoString(record.expiresAt),
    revoked_at: toIsoString(record.revokedAt),
    created_at: toIsoString(record.createdAt),
    updated_at: toIsoString(record.updatedAt),
  };
}

// Function แปลง vehicle job (TicketNumber) จาก DB
export function mapTicketJob(record: TicketJob | null): TicketJobDto | null {
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    ticket_number: record.ticketNumber,
    license_plate: record.licensePlate,
    license_plate_province: record.licensePlateProvince,
    vehicle_type: record.vehicleType,
    workers_required: record.workersRequired,
    dispatch_now: record.dispatchNow,
    status: record.status,
    work_started_at: record.workStartedAt ? toIsoString(record.workStartedAt) : null,
    driver_qr_token: record.driverQrToken,
    expected_ticket_count: record.expectedTicketCount,
    tickets_closed_at: record.ticketsClosedAt ? toIsoString(record.ticketsClosedAt) : null,
    completed_at: record.completedAt ? toIsoString(record.completedAt) : null,
    created_at: toIsoString(record.createdAt),
    updated_at: toIsoString(record.updatedAt),
  };
}

// Function แปลง market job (Business Ticket) จาก DB
export function mapMarketJob(record: MarketJob | null): MarketJobDto | null {
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    vehicle_job_id: record.ticketJobId,
    ticket_no: record.ticketNo,
    ticket_created_at: toIsoString(record.ticketCreatedAt),
    booth_count: record.boothCount,
    gate_transaction_ref: record.gateTransactionRef,
    workers_required: record.workersRequired,
    marketCode: record.marketCode,
    marketName: record.marketName,
    dropoff_point: record.dropoffPoint,
    status: record.status,
    worker_roster_locked_at: record.workerRosterLockedAt ? toIsoString(record.workerRosterLockedAt) : null,
    final_stall_amount: record.finalStallAmount?.toFixed(2) ?? null,
    financialized_at: record.financializedAt ? toIsoString(record.financializedAt) : null,
    completed_at: record.completedAt ? toIsoString(record.completedAt) : null,
    created_at: toIsoString(record.createdAt),
    updated_at: toIsoString(record.updatedAt),
  };
}

// Function แปลง Gate ticket จาก DB
export function mapBoothJob(record: BoothJob | null): BoothJobDto | null {
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    vehicle_job_id: record.ticketJobId,
    market_job_id: record.marketJobId,
    boothCode: record.boothCode,
    boothName: record.boothName,
    vendor_line_id: record.vendorLineId,
    reject_reason: record.rejectReason,
    status: record.status,
    confirmation_status: record.status,
    final_stall_amount: record.finalStallAmount?.toFixed(2) ?? null,
    completed_at: record.completedAt ? toIsoString(record.completedAt) : null,
    financialized_at: record.financializedAt ? toIsoString(record.financializedAt) : null,
    created_at: toIsoString(record.createdAt),
    updated_at: toIsoString(record.updatedAt),
  };
}

// Function แปลง ticket product จาก DB
export function mapTicketProduct(record: TicketProduct | null): TicketProductDto | null {
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    ticket_id: record.ticketId,
    productCode: record.productCode,
    productName: record.productName,
    packageCode: record.packageCode,
    packageName: record.packageName,
    quantity: record.quantity.toString(),
    confirmed_quantity: record.confirmedQuantity?.toString() ?? null,
    created_at: toIsoString(record.createdAt),
    updated_at: toIsoString(record.updatedAt),
  };
}

// Function แปลง ticket worker (roster membership บน Business Ticket) จาก DB
export function mapTicketWorker(record: TicketWorker | null): TicketWorkerDto | null {
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    market_job_id: record.marketJobId,
    worker_id: record.workerId,
    status: record.status,
    final_earning_amount: record.finalEarningAmount?.toFixed(2) ?? null,
    joined_at: toIsoString(record.joinedAt),
    cancelled_at: record.cancelledAt
      ? toIsoString(record.cancelledAt)
      : null,
    completed_at: record.completedAt
      ? toIsoString(record.completedAt)
      : null,
    created_at: toIsoString(record.createdAt),
    updated_at: toIsoString(record.updatedAt),
  };
}

// Function แปลง ticket completion submission จาก DB
export function mapTicketCompletionSubmission(
  record: TicketCompletionSubmission | null
): TicketCompletionSubmissionDto | null {
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    ticket_id: record.ticketId,
    submitted_by_account_id: record.submittedByAccountId,
    submitted_by_worker_id: record.submittedByWorkerId,
    submitted_by_role: record.submittedByRole,
    status: record.status,
    confirmed_at: toIsoString(record.confirmedAt),
    rejected_at: toIsoString(record.rejectedAt),
    reject_reason: record.rejectReason,
    resolved_by_line_user_id: record.resolvedByLineUserId,
    worker_count_snapshot: record.workerCountSnapshot,
    assignment_id: record.assignmentId,
    created_at: toIsoString(record.createdAt),
    updated_at: toIsoString(record.updatedAt),
  };
}


// Function แปลง driver session จาก DB
export function mapDriverSession(record: DriverSession | null): DriverSessionDto | null {
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    vehicle_job_id: record.ticketJobId,
    session_token: record.sessionToken,
    expires_at: toIsoString(record.expiresAt),
    revoked_at: toIsoString(record.revokedAt),
    created_at: toIsoString(record.createdAt),
    updated_at: toIsoString(record.updatedAt),
  };
}

// Function แปลง vehicle job assignment จาก DB
export function mapTicketJobAssignment(
  record: TicketJobAssignment | null
): TicketJobAssignmentDto | null {
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    vehicle_job_id: record.ticketJobId,
    worker_id: record.workerId,
    status: record.status,
    accept_deadline_at: toIsoString(record.acceptDeadlineAt),
    scan_deadline_at: toIsoString(record.scanDeadlineAt),
    accepted_at: toIsoString(record.acceptedAt),
    scanned_at: toIsoString(record.scannedAt),
    completed_at: toIsoString(record.completedAt),
    released_at: toIsoString(record.releasedAt),
    created_at: toIsoString(record.createdAt),
    updated_at: toIsoString(record.updatedAt),
  };
}

// Function แปลง admin action log จาก DB
export function mapAdminActionLog(
  record: (AdminActionLog & { actor?: Account | null }) | null
): AdminActionLogDto | null {
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    vehicle_job_id: record.ticketJobId,
    gate_ticket_id: record.boothJobId,
    market_job_id: record.marketJobId,
    action_type: record.actionType as AdminActionType,
    reason_code: record.reasonCode,
    reason_text: record.reasonText,
    actor_account_id: record.actorAccountId,
    actor_username: record.actor?.username ?? null,
    actor_full_name: record.actor?.fullName ?? null,
    actor_role: record.actor?.role ?? null,
    metadata: (record.metadata as Record<string, unknown> | null) ?? null,
    created_at: toIsoString(record.createdAt),
  };
}
