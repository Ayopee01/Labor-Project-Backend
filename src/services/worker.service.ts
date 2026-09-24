// Import Library
import { Prisma } from "@prisma/client";
// Import Config
import { withTransaction } from "../db/prisma";
// Import Queues
import { claimWorkerFromReadyQueue, decrementWorkerBreakCount, enqueueWorker, getWorkerQueueStatus, incrementWorkerBreakCount, markWorkerBreak, markWorkerOpenApp, removeAssignmentTimeout, removeScanTimeout, removeScanWarning, removeWorkerBreakReturn, scheduleScanTimeout, scheduleScanWarning, scheduleWorkerBreakReturn } from "../queues/worker-queue";
import { applyAssignmentTimeoutQueueAction, autoReleaseTicketJobWorkersIfShiftEnded, dispatchReadyWorkers, handleAssignmentAcceptTimeout } from "../queues/worker-dispatch";
// Import Utils
import { isWorkerSocketConnected, sendWorkerSocketEvent } from "../websockets/worker.socket";
// Import Repositories
import * as workerApplicationRepository from "../repositories/worker.repository";
import * as masterWorkerRepository from "../repositories/shared/master-worker.repository";
import * as workScheduleRepository from "../repositories/shared/work-schedule.repository";
import * as assignmentRepository from "../repositories/shared/ticket-job-assignment.repository";
import * as workerAssignmentEventRepository from "../repositories/shared/worker-assignment-event.repository";
import * as boothJobRepository from "../repositories/shared/booth-job.repository";
import * as marketJobRepository from "../repositories/shared/market-job.repository";
import * as masterDataRepository from "../repositories/shared/master-data.repository";
import * as ticketJobRepository from "../repositories/shared/ticket-job.repository";
import * as workerCheckinLogRepository from "../repositories/shared/worker-checkin-log.repository";
// Import Services
import * as ticketJobLifecycleService from "./shared/ticket-job-lifecycle.service";
import * as ticketCompletionService from "./shared/ticket-completion.service";
import { checkMobileAppVersionForClient } from "./shared/mobile-app-version.service";
import { publishNotification } from "./notifications.service";
import { publishDriverJobUpdate } from "./driver-stream.service";
import { publishRealtimeEvent } from "./shared/realtime-notification.service";
import { getRuntimeSettings } from "./shared/runtime-settings.service";
import { publishAdminWorkerStatusChanged } from "./notifications.service";
import { buildWorkerDailySummary, closeWorkerAttendanceShift, closeWorkerBreakLog, markWorkerAttendanceOnline, scheduleWorkerShiftEndIfNeeded, startWorkerBreakLog } from "./shared/worker-attendance.service";
// Import Types
import type { AccessTokenPayload } from "../types/auth.type";
import { MASTER_WORKER_STATUS } from "../types/admin-workers.type";
import type { MasterWorkerDto } from "../types/admin-workers.type";
import type { BoothJobDto, TicketCompletionResponse, TicketJobAssignmentDto, TicketJobDetailResponse, TicketJobDto, VehicleWorkReadinessDto, WorkerAssignmentAcceptResponse, WorkerAssignmentCheckInResponse, WorkerAssignmentHistoryItemDto, WorkerAssignmentHistoryItemResponse, WorkerAssignmentHistoryResponse, WorkerAssignmentTeamMemberDto, WorkerAssignmentTeamRawMemberDto, WorkerBreakResponse, WorkerCurrentJobResponse, WorkerCurrentJobTeamAcceptResponse, WorkerEarningsSummaryResponse, WorkerOnlineResponse, WorkerProductPackageOptionsResponse, WorkerQueueEntryDto, WorkerShiftCloseReason, WorkerStatusResponse } from "../types/worker.type";
import { WORKER_WORK_STATUS, type WorkerWorkStatus } from "../types/shared/worker-status.type";
import { WORKER_ASSIGNMENT_EVENT_TYPE } from "../types/shared/worker-assignment-event.type";
import type { DbConnection } from "../types/shared/common.type";
// Import Config
import { ASSIGNMENT_STATUS, TICKET_SUBMITTER_ROLE, WORKER_OPEN_APP_REASON, WORKING_ASSIGNMENT_STATUSES } from "../constants/status";
import { resolveShiftInactiveReasonText } from "../utils/shift-status-localization";
// Import Validation
import { parseRequiredReference, parseWithSchema } from "../validation/parser";
import { workerAssignmentHistoryQuerySchema, workerCheckInBarcodeBodySchema, workerEarningsSummaryQuerySchema, workerTicketCompleteBodySchema } from "../validation/schemas";
// Import Utils
import ApiError from "../utils/api-error";
import { logger } from "../utils/logger";
import { buildShiftWaitInfo, buildWorkScheduleShiftInstanceKey, formatScheduleWithShift, isTimeInWorkSchedule } from "../utils/shift";
import { buildBangkokDateRange, buildBangkokDateSpanRange, buildDeadline, buildLatestCompletedBangkokDateRange, buildRemainingBreakTime, formatBangkokDate, formatBangkokDisplayDate, formatBangkokDisplayDateTime, getDelayUntil, toUnixMs } from "../utils/time";
import { buildWorkerTicketPayload } from "../utils/ticket-payload";
import { buildWorkerQueueSocketPayload } from "../utils/worker-payload";
import { resolveTeamReadinessThreshold } from "../utils/team-requirement";
import { resolveShiftActiveStatus, resolveWorkerWorkStatus } from "../utils/worker-status";

/* -------------------------------------- Config -------------------------------------- */

// จำนวนวันย้อนหลังที่แสดงใน "สรุปรายได้ Worker" (getWorkerEarningsSummary)
const EARNINGS_SUMMARY_DAY_COUNT = 15;

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจ Mobile App Version ตอนเปิด App — Public ไม่ต้อง Login, pass through ไปยัง shared service ที่เป็น Single Source of Truth
export async function checkMobileAppVersion(query: unknown) {
  return checkMobileAppVersionForClient(query);
}

// Function เติม break_count_used/break_count_limit/break_duration_minutes ลงใน queue entry
function withBreakUsage(
  queueEntry: WorkerQueueEntryDto,
  breakCountUsed: number,
  breakLimit: number,
  breakDurationMinutes: number,
): WorkerQueueEntryDto {
  return {
    ...queueEntry,
    break_count_used: breakCountUsed,
    break_count_limit: breakLimit,
    break_duration_minutes: breakDurationMinutes,
  };
}

// Function สร้าง worker queue action response ใน service flow
function buildWorkerQueueActionResponse(
  code: string,
  message: string,
): WorkerOnlineResponse {
  return {
    statusCode: 200,
    code,
    message,
  };
}

// Function สร้าง worker assignment accept response ใน service flow
function buildWorkerAssignmentAcceptResponse(
  detail: TicketJobDetailResponse,
  team: WorkerAssignmentTeamMemberDto[],
  assignment: TicketJobAssignmentDto,
  workerCode: string | null,
  coatNo: string | null,
  acceptedCount: number,
): WorkerAssignmentAcceptResponse {
  return {
    ticket_number: detail.vehicle_job.ticket_number,
    worker_code: workerCode,
    shirt_number: coatNo,
    accepted_at: assignment.accepted_at,
    license_plate: detail.vehicle_job.license_plate,
    license_plate_province: detail.vehicle_job.license_plate_province,
    scan_deadline_at: assignment.scan_deadline_at,
    scan_deadline_unix_ms: toUnixMs(assignment.scan_deadline_at),
    team_accept: buildWorkerTeamAcceptResponse(
      detail.vehicle_job.workers_required,
      acceptedCount,
      detail.vehicle_job.removed_after_scan_count,
    ),
    team: team.map((member) => ({
      full_name: member.full_name,
      worker_code: member.worker_code,
      shirt_number: member.coat_no ?? null,
      image_url: member.image_url,
      scan_status: member.scan_status,
    })),
    markets: detail.markets.map((market) => ({
      ticket_no: market.ticket_no,
      created_at: market.created_at,
      marketName: market.marketName,
      stall_count: market.booths.length,
        stalls: market.booths.map((ticket) => ({
          boothCode: ticket.boothCode,
          boothName: ticket.boothName,
          status: ticket.status,
          confirmation_status: ticket.confirmation_status,
          completed_at: ticket.completed_at,
          product_count: ticket.products.length,
          products: ticket.products.map((product) => ({
          productCode: product.productCode,
          productName: product.productName,
          quantity: product.quantity,
          packageName: product.packageName,
        })),
      })),
    })),
  };
}

// Function สร้าง worker assignment history item response ใน service flow
function buildWorkerAssignmentHistoryItemResponse(
  item: WorkerAssignmentHistoryItemDto,
): WorkerAssignmentHistoryItemResponse {
  return {
    ticket_number: item.vehicle_job.ticket_number,
    ticket_completed_at:
      item.assignment.status === ASSIGNMENT_STATUS.COMPLETED
        ? item.assignment.completed_at ?? item.vehicle_job.updated_at
        : null,
    license_plate: item.vehicle_job.license_plate,
    license_plate_province: item.vehicle_job.license_plate_province,
    status: item.assignment.status,
    markets: item.markets,
  };
}

// Function สร้าง worker current job response ใน service flow
function buildWorkerCurrentJobResponse(
  detail: TicketJobDetailResponse,
  team: WorkerAssignmentTeamMemberDto[],
  assignment: TicketJobAssignmentDto,
  teamScan: VehicleWorkReadinessDto,
  scannedTicketNo: string | null,
  acceptedCount: number,
): WorkerCurrentJobResponse {
  return {
    scanned_ticket_no: scannedTicketNo,
    ticket_number: detail.vehicle_job.ticket_number,
    license_plate: detail.vehicle_job.license_plate,
    license_plate_province: detail.vehicle_job.license_plate_province,
    accept_created_at: assignment.created_at,
    accept_deadline_at:
      assignment.status === ASSIGNMENT_STATUS.PENDING
        ? assignment.accept_deadline_at
        : null,
    accept_deadline_unix_ms:
      assignment.status === ASSIGNMENT_STATUS.PENDING
        ? toUnixMs(assignment.accept_deadline_at)
        : null,
    scan_deadline_at:
      assignment.status === ASSIGNMENT_STATUS.ACCEPTED
        ? assignment.scan_deadline_at
        : null,
    scan_deadline_unix_ms:
      assignment.status === ASSIGNMENT_STATUS.ACCEPTED
        ? toUnixMs(assignment.scan_deadline_at)
        : null,
    work_started_at:
      detail.vehicle_job.work_started_at,
    work_started_at_unix_ms:
      toUnixMs(detail.vehicle_job.work_started_at),
    vehicle_type: detail.vehicle_job.vehicle_type,
    team_accept: buildWorkerTeamAcceptResponse(
      detail.vehicle_job.workers_required,
      acceptedCount,
      detail.vehicle_job.removed_after_scan_count,
    ),
    team_scan: buildWorkerTeamScanResponse(teamScan),
    markets: detail.markets.map((market) => ({
      ticket_no: market.ticket_no,
      created_at: market.created_at,
      marketCode: market.marketCode,
      marketName: market.marketName,
      booths: market.booths.map((ticket) => ({
        boothCode: ticket.boothCode,
        boothName: ticket.boothName,
        status: ticket.status,
        confirmation_status: ticket.confirmation_status,
        completed_at: ticket.completed_at,
        products: ticket.products.map((product) => ({
          productCode: product.productCode,
          productName: product.productName,
          packageCode: product.packageCode,
          packageName: product.packageName,
          quantity: product.quantity,
          confirmed_quantity: product.confirmed_quantity,
        })),
      })),
    })),
    team: team.map((member) => ({
      shirt_number: member.coat_no ?? null,
      image_url: member.image_url,
      full_name: member.full_name,
      scan_status: member.scanned_at ? "scanned" : "not_scanned",
      scanned_at: member.scanned_at ?? null,
    })),
  };
}

function buildWorkerTeamScanResponse(readiness: VehicleWorkReadinessDto) {
  return {
    workers_required: readiness.workers_required,
    checked_in_count: readiness.checked_in_count,
    remaining_count: readiness.remaining_count,
    is_ready: readiness.is_ready,
  };
}

// Function สร้าง response สรุปว่าตอนนี้มีคน Accept งานนี้แล้วกี่คนจากที่ต้องการทั้งหมด
function buildWorkerTeamAcceptResponse(
  workersRequired: number,
  acceptedCount: number,
  removedAfterScanCount: number,
): WorkerCurrentJobTeamAcceptResponse {
  // workers_required แสดงขนาดทีมตั้งต้น ส่วน remaining/is_ready หักคนที่ Admin ถอดออกหลัง Scan แล้วเหมือน team_scan
  const readinessThreshold = resolveTeamReadinessThreshold(
    workersRequired,
    removedAfterScanCount,
  );
  const remainingCount = Math.max(0, readinessThreshold - acceptedCount);
  return {
    workers_required: workersRequired,
    accepted_count: acceptedCount,
    remaining_count: remainingCount,
    is_ready: readinessThreshold > 0 && acceptedCount >= readinessThreshold,
  };
}

// Function จัดหมวด scan_status ของสมาชิกทีมจากสถานะ/timestamp ดิบ — ย้ายมาจาก repository เพราะเป็น business classification ไม่ใช่ data access
function buildAssignmentScanStatus(member: WorkerAssignmentTeamRawMemberDto): string {
  if (member.status === ASSIGNMENT_STATUS.COMPLETED || member.completed_at) {
    return "completed";
  }

  if (WORKING_ASSIGNMENT_STATUSES.includes(member.status) || member.scanned_at) {
    return "scanned";
  }

  if (member.status === ASSIGNMENT_STATUS.ACCEPTED || member.accepted_at) {
    return "accepted";
  }

  return "pending";
}

// Function ดึงทีม assignment ของ TicketJob พร้อม scan_status ที่คำนวณแล้ว ให้ทุก caller ในไฟล์นี้ใช้ร่วมกัน
async function listTicketJobAssignmentTeamWithScanStatus(
  ticketJobId: number,
): Promise<WorkerAssignmentTeamMemberDto[]> {
  const rawTeam = await assignmentRepository.listTicketJobAssignmentTeam(ticketJobId);

  return rawTeam.map((member) => ({
    worker_id: member.worker_id,
    full_name: member.full_name,
    worker_code: member.worker_code,
    coat_no: member.coat_no,
    image_url: member.image_url,
    scan_status: buildAssignmentScanStatus(member),
    accepted_at: member.accepted_at,
    scanned_at: member.scanned_at,
  }));
}

// Function แปลง teamScan readiness เป็น worker_status ที่จะส่งใน ASSIGNMENT_TEAM_UPDATED
function resolveTeamUpdatedWorkerStatus(
  teamScan: VehicleWorkReadinessDto,
): WorkerWorkStatus {
  if (teamScan.is_ready) {
    return WORKER_WORK_STATUS.WORKING;
  }

  if (teamScan.checked_in_count > 0) {
    return WORKER_WORK_STATUS.WAITING_TEAM;
  }

  return WORKER_WORK_STATUS.ASSIGNED;
}

// Function สร้าง payload สำหรับ event ASSIGNMENT_TEAM_UPDATED
function buildAssignmentTeamUpdatedSocketPayload(
  ticketNumber: string,
  team: WorkerAssignmentTeamMemberDto[],
  teamScan: VehicleWorkReadinessDto,
) {
  return {
    ticketNumber,
    worker_status: resolveTeamUpdatedWorkerStatus(teamScan),
    team_scan: buildWorkerTeamScanResponse(teamScan),
    team: team.map((member) => ({
      worker_code: member.worker_code,
      shirt_number: member.coat_no ?? null,
      full_name: member.full_name,
      image_url: member.image_url,
      scan_status: member.scan_status,
      accepted_at: member.accepted_at ?? null,
      scanned_at: member.scanned_at ?? null,
    })),
  };
}

// Function ส่ง ASSIGNMENT_TEAM_UPDATED ให้สมาชิกทีมทุกคนแบบไม่ซ้ำ (dedupe worker_id ด้วย Set)
function sendAssignmentTeamUpdatedSocketEvents(
  ticketNumber: string,
  team: WorkerAssignmentTeamMemberDto[],
  teamScan: VehicleWorkReadinessDto,
): void {
  const payload = buildAssignmentTeamUpdatedSocketPayload(
    ticketNumber,
    team,
    teamScan,
  );

  for (const workerId of new Set(
    team
      .map((member) => member.worker_id)
      .filter((value): value is number => typeof value === "number"),
  )) {
    sendWorkerSocketEvent(
      workerId,
      "ASSIGNMENT_TEAM_UPDATED",
      payload,
      {
        push: false,
      },
    );
  }
}

// Function sync team-scan readiness ให้ทุกคนในทีมผ่าน ASSIGNMENT_TEAM_UPDATED เสมอ (push: false)
// และยิง TEAM_READY เพิ่ม (push จริง) เมื่อ readiness เพิ่งครบพอดี ให้ worker ที่ไม่ได้ต่อ socket ก็รู้ตัว
// — ใช้ร่วมกันทั้งตอน worker สแกนเข้างานเอง และตอน Admin ยกเลิก assignment เพื่อนร่วมทีมจนทีมพร้อมพอดี
export async function notifyTicketJobTeamScanReadiness(
  ticketJob: TicketJobDto,
  teamScan: VehicleWorkReadinessDto,
  // false = ส่งแค่ ASSIGNMENT_TEAM_UPDATED ไม่ประกาศ TEAM_READY (มี push) ซ้ำ ใช้เมื่อทีมพร้อมทำงานอยู่ก่อนแล้ว
  options: { announceReady?: boolean } = {},
): Promise<void> {
  const team = await listTicketJobAssignmentTeamWithScanStatus(ticketJob.id);

  sendAssignmentTeamUpdatedSocketEvents(ticketJob.ticket_number, team, teamScan);

  if (!teamScan.is_ready || options.announceReady === false) {
    return;
  }

  const teamWorkerAccountIds = team
    .map((member) => member.worker_id)
    .filter((value): value is number => typeof value === "number");
  const ticketNos = await marketJobRepository.listActiveTicketNosByTicketJobId(
    ticketJob.id,
  );

  publishRealtimeEvent({
    type: "TEAM_READY",
    title: "Team ready",
    message: `The whole team has checked in for vehicle job ${ticketJob.ticket_number}. Work can start now.`,
    payload: {
      ticketNumber: ticketJob.ticket_number,
      ticketNos,
    },
    worker_payload: {
      ticketNumber: ticketJob.ticket_number,
      ticketNos,
    },
    worker_ids: teamWorkerAccountIds,
  });
}

// Function สร้าง assignment accepted socket payload ใน service flow
function buildAssignmentAcceptedSocketPayload(
  assignment: TicketJobAssignmentDto,
  detail: TicketJobDetailResponse,
  workerCode: string | null,
) {
  return {
    worker_code: workerCode,
    status: assignment.status,
    ticketNumber: detail.vehicle_job.ticket_number,
    accepted_at: assignment.accepted_at,
    scan_deadline_at: assignment.scan_deadline_at,
    scan_deadline_unix_ms: toUnixMs(assignment.scan_deadline_at),
  };
}

// Function ตรวจว่า scan deadline expired ใน service flow
function isScanDeadlineExpired(scanDeadlineAt: string | null): boolean {
  if (!scanDeadlineAt) {
    return true;
  }

  const deadlineMs = new Date(scanDeadlineAt).getTime();

  return !Number.isFinite(deadlineMs) || deadlineMs <= Date.now();
}


// Function ตรวจสอบว่า auth payload ปัจจุบันเป็นบัญชี worker ที่ active
async function requireWorker(auth?: AccessTokenPayload) {
  if (!auth) {
    throw new ApiError(401, "UNAUTHORIZED", "Authentication is required.");
  }

  if (auth.role !== "worker") {
    throw new ApiError(403, "FORBIDDEN", "Worker account is required.");
  }

  const worker = await masterWorkerRepository.findById(auth.account_id);

  if (!worker || worker.status !== MASTER_WORKER_STATUS.ACTIVE) {
    throw new ApiError(
      403,
      "WORKER_NOT_ACTIVE",
      "Worker account is not active.",
    );
  }

  return worker;
}

// Function ค้นหา worker assignment ตาม reference ใน service flow
async function findWorkerAssignmentByReference(
  value: unknown,
  workerId: number,
  connection?: Parameters<
    typeof assignmentRepository.findCurrentAssignmentByTicketJobRefAndWorker
  >[2],
): Promise<TicketJobAssignmentDto | null> {
  const reference = parseRequiredReference(value, "INVALID_ASSIGNMENT_REF", "Vehicle job ref is invalid.");

  return assignmentRepository.findCurrentAssignmentByTicketJobRefAndWorker(
    reference,
    workerId,
    connection,
  );
}

// Function ค้นหา Gate ticket สำหรับ completion จาก assignment ปัจจุบันของ worker + booth — scope
// ด้วย vehicle_job_id ของ assignment ที่ worker active อยู่ ไม่รับ TicketNumber จาก client โดยตรง
// ticketNo/boothCode ผ่าน workerTicketCompleteBodySchema (trim + required) มาแล้วเสมอ
async function requireBoothJobForCompletionByCurrentAssignment(
  workerId: number,
  ticketNo: string,
  boothCode: string,
  connection: DbConnection,
): Promise<BoothJobDto> {
  const assignment = await assignmentRepository.findCurrentAssignmentByWorker(
    workerId,
    connection,
  );

  if (assignment) {
    const ticketOnCurrentAssignment =
      await boothJobRepository.findBoothJobForCompletionByTicketJobIdAndTicketNoAndBoothCode(
        assignment.vehicle_job_id,
        ticketNo,
        boothCode,
        connection,
      );

    if (ticketOnCurrentAssignment) {
      return ticketOnCurrentAssignment;
    }
  }

  // Fallback: ถ้าไม่พบใน assignment active ปัจจุบัน (เช่น Admin release ไปแล้ว) ให้หาจากประวัติ scan เข้างานแทน
  const ticketViaHistory =
    await boothJobRepository.findBoothJobForCompletionByWorkerHistoryAndTicketNoAndBoothCode(
      workerId,
      ticketNo,
      boothCode,
      connection,
    );

  if (!ticketViaHistory) {
    throw new ApiError(404, "ASSIGNMENT_NOT_FOUND", "Assignment not found.");
  }

  return ticketViaHistory;
}

// Function ดึงรายการ PackageCode ที่ยังใช้งานอยู่ของ ProductCode เดียว ให้ Worker เลือกตอนแก้ไขยอดส่ง
// — PackageName ไว้แสดงบน UI เท่านั้น ต้องส่ง PackageCode กลับตอน submit จริง
export async function getWorkerProductPackageOptions(
  productCodeParam: unknown,
  auth?: AccessTokenPayload,
): Promise<WorkerProductPackageOptionsResponse> {
  await requireWorker(auth);

  const productCode = String(productCodeParam ?? "").trim();

  if (!productCode) {
    throw new ApiError(400, "INVALID_PRODUCT_CODE", "ProductCode is invalid.");
  }

  const rows =
    await masterDataRepository.listActiveMasterProductPackagesByProductCode(
      productCode,
    );

  if (rows.length === 0) {
    throw new ApiError(
      404,
      "PRODUCT_NOT_FOUND",
      "Active product was not found.",
    );
  }

  // ตัดคู่ ProductCode+PackageCode ที่ ambiguous ออก (PackageWeight ไม่ตรงกันข้ามแถว) เพราะ submit จะชน AMBIGUOUS_PRODUCT_PACKAGE
  // ส่วนคู่ที่ PackageWeight เท่ากันทุกแถว เหลือไว้แค่ 1 รายการ
  const weightsByPairKey = new Map<string, Set<number>>();

  for (const row of rows) {
    const key = `${row.productCode}:${row.packageCode}`;
    const weights = weightsByPairKey.get(key) ?? new Set<number>();

    weights.add(row.packageWeight);
    weightsByPairKey.set(key, weights);
  }

  const seenPairKeys = new Set<string>();
  const packages = rows.flatMap((row) => {
    const key = `${row.productCode}:${row.packageCode}`;

    if ((weightsByPairKey.get(key)?.size ?? 0) > 1) {
      return [];
    }

    if (seenPairKeys.has(key)) {
      return [];
    }

    seenPairKeys.add(key);

    return [
      {
        PackageCode: row.packageCode,
        PackageName: row.packageName,
        PackageWeight: row.packageWeight,
      },
    ];
  });

  return {
    ProductCode: productCode,
    ProductName: rows[0].productName,
    Packages: packages,
  };
}

// Function จัดการ worker online ใน service flow
export async function workerOnline(
  auth?: AccessTokenPayload,
): Promise<WorkerOnlineResponse> {
  const account = await requireWorker(auth);

  if (!isWorkerSocketConnected(account.id)) {
    throw new ApiError(
      409,
      "WORKER_SOCKET_NOT_CONNECTED",
      "Worker WebSocket must be connected before going online.",
    );
  }

  const currentSchedule = await workScheduleRepository.findCurrentByAccountId(
    account.id,
  );

  if (!currentSchedule) {
    throw new ApiError(
      403,
      "WORK_SCHEDULE_NOT_FOUND",
      "Worker does not have a current work schedule.",
    );
  }

  if (!isTimeInWorkSchedule(currentSchedule)) {
    throw new ApiError(
      403,
      "OUTSIDE_WORK_SHIFT",
      "Worker can go online only during the assigned work shift.",
      buildShiftWaitInfo(currentSchedule),
    );
  }
  const shiftInstanceKey = buildWorkScheduleShiftInstanceKey(currentSchedule);

  await withTransaction(async (transaction) => {
    const currentAssignment =
      await assignmentRepository.findCurrentAssignmentByWorker(
        account.id,
        transaction,
      );

    if (currentAssignment) {
      await ticketJobLifecycleService.closeCompletedTicketJobIfReady(
        currentAssignment.vehicle_job_id,
        transaction,
      );
      const refreshedAssignment =
        await assignmentRepository.findCurrentAssignmentByWorker(
          account.id,
          transaction,
        );

      if (refreshedAssignment) {
        throw new ApiError(
          409,
          "WORKER_HAS_ACTIVE_ASSIGNMENT",
          "Worker already has an active assignment.",
        );
      }
    }

    const currentQueueEntry = await getWorkerQueueStatus(account.id);
    const isReturningFromBreak =
      currentQueueEntry?.status === WORKER_WORK_STATUS.BREAK;
    const attendance =
      await workerCheckinLogRepository.findByWorkerAndShift(
        {
          worker_id: account.id,
          shift_instance_key: shiftInstanceKey,
        },
        transaction,
      );

    if (isReturningFromBreak) {
      await removeWorkerBreakReturn(account.id, currentSchedule.id);
      await closeWorkerBreakLog(account.id, shiftInstanceKey, "early_return", transaction);
    } else {
      if (attendance?.closedAt) {
        throw new ApiError(
          409,
          "WORKER_SHIFT_CLOSED",
          "Worker already ended this shift and cannot go online again.",
        );
      }

      // ASSIGNED ทั้งที่ไม่มี assignment active จริงใน DB (เช็คผ่านด้านบนแล้ว) คือสถานะค้างจาก Redis กับ DB
      // ไม่ตรงกัน (เช่น Redis ล้มหลัง timeout commit) ให้ Worker กด online เพื่อกู้กลับเข้าคิวเองได้
      const isStaleAssigned =
        currentQueueEntry?.status === WORKER_WORK_STATUS.ASSIGNED;

      if (
        attendance?.firstOnlineAt &&
        currentQueueEntry?.status !== WORKER_WORK_STATUS.READY &&
        !isStaleAssigned
      ) {
        throw new ApiError(
          409,
          "WORKER_SHIFT_ONLINE_ALREADY_USED",
          "Worker can go online from open_app only once in this shift.",
        );
      }
    }
    await markWorkerAttendanceOnline(
      account,
      currentSchedule,
      shiftInstanceKey,
      transaction,
    );
    await scheduleWorkerShiftEndIfNeeded(account.id, currentSchedule);

    if (currentQueueEntry?.status !== WORKER_WORK_STATUS.READY) {
      await enqueueWorker(account.id);
    }
  });

  // ต้องเรียกหลัง transaction ข้างบน commit แล้วเท่านั้น เพราะ dispatch เขียน Redis/BullMQ ของ worker คนอื่นแยกจาก DB
  // ถ้าอยู่ใน transaction เดิมแล้ว rollback ทีหลัง Redis/BullMQ จะไม่ rollback ตาม ทำให้ค้างสถานะ ASSIGNED
  try {
    await dispatchReadyWorkers();
  } catch (error) {
    logger.error("Worker online dispatch failed after attendance was recorded.", {
      workerId: account.id,
      error,
    });
  }

  const latestQueueEntry = await getWorkerQueueStatus(account.id);
  const latestAssignment =
    await assignmentRepository.findCurrentAssignmentByWorker(account.id);
  // ต้องเช็ค teamScan ด้วย ไม่งั้น resolveWorkerWorkStatus จะขึ้น WORKING ทันทีที่ worker คนนี้ scan แล้ว ทั้งที่ทีมยังมาไม่ครบ
  const latestTeamScan = latestAssignment
    ? await assignmentRepository.getTicketJobTeamScanReadiness(
        latestAssignment.vehicle_job_id,
      )
    : null;

  if (!latestQueueEntry) {
    throw new ApiError(
      404,
      "WORKER_QUEUE_NOT_FOUND",
      "Worker queue entry not found.",
    );
  }

  const workerCode = account.labor_code;
  const response = buildWorkerQueueActionResponse(
    "WORKER_ONLINE_SUCCESS",
    "Worker entered queue successfully.",
  );

  sendWorkerSocketEvent(account.id, "WORKER_STATUS_CHANGED", {
    queue: buildWorkerQueueSocketPayload(
      latestQueueEntry,
      workerCode,
      latestAssignment,
      latestTeamScan,
    ),
  });
  publishAdminWorkerStatusChanged({
    title: "Worker online",
    message: `Worker ${account.full_name} is ready for work.`,
    workerCode,
    queue: latestQueueEntry,
    assignment: latestAssignment,
    team_scan_readiness: latestTeamScan,
    reason: "worker_online",
  });

  return response;
}

// Function รวมตรรกะปิดกะ/อัปเดตคิว/แจ้งเตือน admin เมื่อ worker ออกจากสถานะ online (ใช้ซ้ำได้ทั้งจาก workerOffline และ auto-cascade ตอน logout)
export async function performWorkerOfflineCascade(
  account: MasterWorkerDto,
  reason: WorkerShiftCloseReason,
): Promise<WorkerOnlineResponse> {
  const [currentSchedule, currentQueueEntry, currentAssignment] =
    await Promise.all([
      workScheduleRepository.findCurrentByAccountId(account.id),
      getWorkerQueueStatus(account.id),
      assignmentRepository.findCurrentAssignmentByWorker(account.id),
    ]);
  // ต้องเช็ค teamScan ด้วย ไม่งั้น resolveWorkerWorkStatus จะขึ้น WORKING ทันทีที่ worker คนนี้ scan แล้ว ทั้งที่ทีมยังมาไม่ครบ
  const currentTeamScan = currentAssignment
    ? await assignmentRepository.getTicketJobTeamScanReadiness(
        currentAssignment.vehicle_job_id,
      )
    : null;

  if (
    currentQueueEntry?.status === WORKER_WORK_STATUS.BREAK &&
    currentSchedule
  ) {
    await removeWorkerBreakReturn(account.id, currentSchedule.id);
    await closeWorkerBreakLog(
      account.id,
      buildWorkScheduleShiftInstanceKey(currentSchedule),
      "shift_closed",
    );
  }

  if (currentSchedule) {
    const shiftInstanceKey = buildWorkScheduleShiftInstanceKey(currentSchedule);

    await closeWorkerAttendanceShift(
      account,
      currentSchedule,
      shiftInstanceKey,
      reason,
    );
  }

  const queueEntry = await markWorkerOpenApp(account.id);
  const workerCode = account.labor_code;
  const response = buildWorkerQueueActionResponse(
    "WORKER_OFFLINE_SUCCESS",
    "Worker left queue successfully.",
  );

  sendWorkerSocketEvent(account.id, "WORKER_STATUS_CHANGED", {
    queue: buildWorkerQueueSocketPayload(
      queueEntry,
      workerCode,
      currentAssignment,
      currentTeamScan,
    ),
  });
  publishAdminWorkerStatusChanged({
    title: "Worker moved to open_app",
    message: `Worker ${account.full_name} moved to open_app.`,
    workerCode,
    queue: queueEntry,
    assignment: currentAssignment,
    team_scan_readiness: currentTeamScan,
    reason: "worker_open_app",
  });

  return response;
}

// Function จัดการ worker offline ใน service flow
export async function workerOffline(
  auth?: AccessTokenPayload,
): Promise<WorkerOnlineResponse> {
  const account = await requireWorker(auth);

  return performWorkerOfflineCascade(account, "worker_offline");
}

// Function จัดการ worker break ใน service flow
export async function workerBreak(
  auth?: AccessTokenPayload,
): Promise<WorkerBreakResponse> {
  const account = await requireWorker(auth);
  const settings = await getRuntimeSettings();
  const currentSchedule = await workScheduleRepository.findCurrentByAccountId(
    account.id,
  );

  if (!currentSchedule) {
    throw new ApiError(
      403,
      "WORK_SCHEDULE_NOT_FOUND",
      "Worker does not have a current work schedule.",
    );
  }

  if (!isTimeInWorkSchedule(currentSchedule)) {
    throw new ApiError(
      403,
      "OUTSIDE_WORK_SHIFT",
      "Worker can take a break only during the assigned work shift.",
      buildShiftWaitInfo(currentSchedule),
    );
  }

  const shiftInstanceKey = buildWorkScheduleShiftInstanceKey(currentSchedule);
  const [queueEntry, currentAssignment] = await Promise.all([
    getWorkerQueueStatus(account.id),
    assignmentRepository.findCurrentAssignmentByWorker(account.id),
  ]);

  if (currentAssignment) {
    throw new ApiError(
      409,
      "WORKER_HAS_ACTIVE_ASSIGNMENT",
      "Worker already has an active assignment.",
    );
  }

  if (!queueEntry || queueEntry.status !== WORKER_WORK_STATUS.READY) {
    throw new ApiError(
      409,
      "WORKER_NOT_READY",
      "Worker can take a break only while ready in queue.",
    );
  }

  // Claim ออกจากคิว READY แบบ Atomic (ZREM) ก่อนแตะโควตาพักเสมอ กันสอง request พร้อมกันหักโควตาซ้ำจากการกดพักครั้งเดียว
  const claimedFromQueue = await claimWorkerFromReadyQueue(account.id);

  if (!claimedFromQueue) {
    throw new ApiError(
      409,
      "WORKER_NOT_READY",
      "Worker can take a break only while ready in queue.",
    );
  }

  // Increment ก่อนเช็ค limit เสมอ (Redis INCR atomic) กันสอง request อ่านค่าเดิมพร้อมกันแล้วผ่าน limit ทั้งคู่
  // ถ้า increment แล้วเกิน limit ต้อง decrement คืนทันทีก่อน throw
  const breakCountUsed = await incrementWorkerBreakCount(
    account.id,
    shiftInstanceKey,
  );

  if (breakCountUsed > settings.worker_break_limit) {
    await decrementWorkerBreakCount(account.id, shiftInstanceKey);
    // คืน Worker เข้าคิว READY เหมือนเดิม เพราะ Claim ออกจากคิวไปแล้วแต่พักไม่สำเร็จ (เกิน Limit)
    await enqueueWorker(account.id);

    throw new ApiError(
      409,
      "BREAK_LIMIT_REACHED",
      "Worker break limit reached for this shift.",
    );
  }

  const breakDurationMs = settings.worker_break_duration_minutes * 60 * 1000;
  const breakUntil = buildDeadline(breakDurationMs);
  const breakEntry = await markWorkerBreak(account.id, breakUntil);
  await startWorkerBreakLog(account.id, shiftInstanceKey, breakUntil);

  await scheduleWorkerBreakReturn(
    account.id,
    currentSchedule.id,
    breakDurationMs,
  );
  await scheduleWorkerShiftEndIfNeeded(account.id, currentSchedule);

  const breakQueueEntry = withBreakUsage(
    breakEntry,
    breakCountUsed,
    settings.worker_break_limit,
    settings.worker_break_duration_minutes,
  );
  const workerCode = account.labor_code;
  sendWorkerSocketEvent(account.id, "WORKER_STATUS_CHANGED", {
    queue: buildWorkerQueueSocketPayload(breakQueueEntry, workerCode),
  });
  publishAdminWorkerStatusChanged({
    title: "Worker on break",
    message: `Worker ${account.full_name} is on break.`,
    workerCode,
    queue: breakQueueEntry,
    reason: "worker_break",
  });

  return {
    full_name: account.full_name ?? account.labor_code,
    worker_code: workerCode,
    status: resolveWorkerWorkStatus(breakQueueEntry, null),
    break_count_used: breakCountUsed,
    break_count_limit: settings.worker_break_limit,
    break_duration_minutes: settings.worker_break_duration_minutes,
  };
}

// Function ดึง worker status ใน service flow
export async function getWorkerStatus(
  auth?: AccessTokenPayload,
): Promise<WorkerStatusResponse> {
  const account = await requireWorker(auth);

  const [currentSchedule, queueEntry, currentAssignment, settings] =
    await Promise.all([
      workScheduleRepository.findCurrentByAccountId(account.id),
      getWorkerQueueStatus(account.id),
      assignmentRepository.findCurrentAssignmentByWorker(account.id),
      getRuntimeSettings(),
    ]);
  const schedule = formatScheduleWithShift(currentSchedule);
  let status = resolveWorkerWorkStatus(queueEntry, currentAssignment);
  const dailySummary = await buildWorkerDailySummary(
    account.id,
    currentSchedule,
  );
  // shift_active ต้องผ่านทั้ง 2 เงื่อนไข: อยู่ในช่วงเวลากะจริง และยังไม่ถูกปิดกะไปก่อนหน้านี้ (closedAt เป็น null)
  // ถ้าออกกะไปแล้วต้องเป็น false ทันทีโดยไม่ต้องรอพ้นเวลากะ
  const isWithinShiftTime = Boolean(
    currentSchedule && isTimeInWorkSchedule(currentSchedule),
  );
  const attendance = currentSchedule
    ? await workerCheckinLogRepository.findByWorkerAndShift({
        worker_id: account.id,
        shift_instance_key: buildWorkScheduleShiftInstanceKey(currentSchedule),
      })
    : null;
  // ถ้าเคย Go Online มาแล้วในกะนี้ (firstOnlineAt ไม่ null) แต่ตอนนี้ถูกเด้งกลับ open_app
  // (พลาด scan/ถูก admin cancel/พักเบรกจบแล้ว requeue ไม่ได้ ฯลฯ) ต้องถือว่าไม่ eligible แล้ว
  // เพราะ worker กด Go Online เองซ้ำไม่ได้อีกในกะนี้ (ดู WORKER_SHIFT_ONLINE_ALREADY_USED) ต้องรอ Admin force กลับให้เท่านั้น
  // เหตุผลที่ shift_active เป็น false (ถ้ามี) ให้ FE โชว์ข้อความอธิบายได้ตรงสาเหตุ — ใช้ resolver กลาง
  // เดียวกับฝั่ง Admin (GET /api/admin/jobs/workers/status) กัน logic ตัดสินโค้ดสองฝั่งเพี้ยนไปจากกัน
  const { active: shiftActive, reasonCode } = resolveShiftActiveStatus({
    isWithinShiftTime,
    closedAt: attendance?.closedAt,
    closeReason: attendance?.closeReason,
    firstOnlineAt: attendance?.firstOnlineAt,
    queueStatus: queueEntry?.status,
    openAppReason: queueEntry?.open_app_reason,
  });

  const response: WorkerStatusResponse = {
    full_name: account.full_name ?? account.labor_code,
    worker_code: account.labor_code,
    image_url: account.image_url,
    status,
    ...dailySummary,
    break_count_limit: settings.worker_break_limit,
    break_duration_minutes: settings.worker_break_duration_minutes,
    nationality: account.nationality,
    work_start_date: account.work_start_date,
    phone: account.telephone,
    shift: schedule
      ? {
          name: schedule.shift_name,
          start_time: schedule.time_in,
          end_time: schedule.time_out,
        }
      : null,
    shift_active: shiftActive,
    ...(reasonCode
      ? {
          reason_code: reasonCode,
          reason_text: resolveShiftInactiveReasonText(reasonCode, account.lang, {
            accept_timeout_limit: settings.worker_accept_timeout_limit,
            break_retry_minutes: settings.worker_break_retry,
          }),
        }
      : {}),
  };
  const remainingBreakTime =
    status === WORKER_WORK_STATUS.BREAK
      ? buildRemainingBreakTime(queueEntry?.break_until)
      : null;

  if (
    status === WORKER_WORK_STATUS.BREAK &&
    queueEntry?.break_until &&
    remainingBreakTime
  ) {
    response.break_until = queueEntry.break_until;
    response.break_until_unix_ms = toUnixMs(queueEntry.break_until);
    response.remaining_break_time = remainingBreakTime;
  }

  if (
    currentAssignment &&
    (status === WORKER_WORK_STATUS.ASSIGNED ||
      status === WORKER_WORK_STATUS.WAITING_TEAM ||
      status === WORKER_WORK_STATUS.WORKING)
  ) {
    const [detail, team, teamScan, scannedEventMetadata, acceptedCount] =
      await Promise.all([
        ticketJobRepository.getTicketJobDetail(
          currentAssignment.vehicle_job_id,
        ),
        listTicketJobAssignmentTeamWithScanStatus(
          currentAssignment.vehicle_job_id,
        ),
        assignmentRepository.getTicketJobTeamScanReadiness(
          currentAssignment.vehicle_job_id,
        ),
        // ดึง TicketNo ที่ worker Scan ไว้ (บันทึกตอน scanWorkerAssignment) ให้ UI แสดงถูกแม้ปิดเปิดแอพใหม่
        workerAssignmentEventRepository.findMetadataByAssignmentAndType(
          currentAssignment.id,
          WORKER_ASSIGNMENT_EVENT_TYPE.SCANNED,
        ),
        assignmentRepository.countAcceptedAssignments(
          currentAssignment.vehicle_job_id,
        ),
      ]);
    status = resolveWorkerWorkStatus(queueEntry, currentAssignment, teamScan);
    response.status = status;

    if (detail) {
      response.current_job = buildWorkerCurrentJobResponse(
        detail,
        team,
        currentAssignment,
        teamScan,
        typeof scannedEventMetadata?.ticket_no === "string"
          ? scannedEventMetadata.ticket_no
          : null,
        acceptedCount,
      );
    }
  }

  return response;
}

// Function ดึงรายการ worker assignment history ใน service flow
export async function listWorkerAssignmentHistory(
  query: unknown,
  auth?: AccessTokenPayload,
): Promise<WorkerAssignmentHistoryResponse> {
  const account = await requireWorker(auth);
  const input = parseWithSchema(workerAssignmentHistoryQuerySchema, query);
  const selectedDate = input.date ?? (
    !input.date_from && !input.date_to ? formatBangkokDate() : undefined
  );
  const range =
    selectedDate
      ? buildBangkokDateRange(selectedDate)
      : buildBangkokDateSpanRange(input.date_from, input.date_to);

  if (!range.startAt || !range.endAt) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Invalid assignment history date range.",
    );
  }

  const history =
    await workerApplicationRepository.listWorkerAssignmentHistoryByDate(
      account.id,
      range.startAt,
      range.endAt,
    );
  const usesPagination = input.page !== undefined || input.limit !== undefined;
  const page = input.page ?? 1;
  const limit = input.limit ?? 20;
  const offset = (page - 1) * limit;
  const pagedHistory = usesPagination
    ? history.slice(offset, offset + limit)
    : history;

  const response: WorkerAssignmentHistoryResponse = {
    date: selectedDate ?? input.date_from ?? "",
    summary: {
      job_count: history.length,
      accept_timeout_job_count: history.filter(
        (item) =>
          item.assignment.status === ASSIGNMENT_STATUS.TIMEOUT &&
          item.assignment.accepted_at === null,
      ).length,
      completed_job_count: history.filter(
        (item) => item.assignment.status === ASSIGNMENT_STATUS.COMPLETED,
      ).length,
    },
    data: pagedHistory.map(buildWorkerAssignmentHistoryItemResponse),
  };

  if (usesPagination) {
    response.pagination = {
      page,
      limit,
      total: history.length,
      total_pages: Math.ceil(history.length / limit),
    };
  }

  return response;
}

// Function สรุปรายได้รายวัน/รวมของ worker ย้อนหลัง EARNINGS_SUMMARY_DAY_COUNT วัน
export async function getWorkerEarningsSummary(
  query: unknown,
  auth?: AccessTokenPayload,
): Promise<WorkerEarningsSummaryResponse> {
  const account = await requireWorker(auth);
  parseWithSchema(workerEarningsSummaryQuerySchema, query);

  const dayCount = EARNINGS_SUMMARY_DAY_COUNT;
  const { startAt, endAt, dates } =
    buildLatestCompletedBangkokDateRange(dayCount);
  const rows = await workerApplicationRepository.listWorkerEarningsSummaryRows(
    account.id,
    startAt,
    endAt,
  );
  const dailyEarnings = new Map(
    dates.map((date) => [date, new Prisma.Decimal(0)]),
  );
  let totalEarnings = new Prisma.Decimal(0);

  const details = rows.map((row) => {
    const earnings = new Prisma.Decimal(row.earnings);
    const dateKey = formatBangkokDate(new Date(row.completed_at));

    totalEarnings = totalEarnings.plus(earnings);
    dailyEarnings.set(
      dateKey,
      (dailyEarnings.get(dateKey) ?? new Prisma.Decimal(0)).plus(earnings),
    );

    return {
      ...row,
      completed_at: formatBangkokDisplayDateTime(row.completed_at),
      earnings: earnings.toFixed(2),
    };
  });

  return {
    period: {
      from_date: formatBangkokDisplayDate(startAt),
      to_date: formatBangkokDisplayDate(new Date(endAt.getTime() - 1)),
      day_count: dayCount,
    },
    total_earnings: totalEarnings.toFixed(2),
    daily: dates.map((date) => ({
      date: formatBangkokDisplayDate(new Date(`${date}T00:00:00.000+07:00`)),
      earnings: (dailyEarnings.get(date) ?? new Prisma.Decimal(0)).toFixed(2),
    })),
    details,
  };
}

// Function รับ worker assignment ใน service flow
export async function acceptWorkerAssignment(
  assignmentIdParam: unknown,
  auth?: AccessTokenPayload,
): Promise<WorkerAssignmentAcceptResponse> {
  const account = await requireWorker(auth);
  const assignment = await findWorkerAssignmentByReference(
    assignmentIdParam,
    account.id,
  );

  if (!assignment) {
    throw new ApiError(404, "ASSIGNMENT_NOT_FOUND", "Assignment not found.");
  }

  if (assignment.status !== ASSIGNMENT_STATUS.PENDING) {
    throw new ApiError(
      409,
      "ASSIGNMENT_NOT_PENDING",
      "Assignment is not pending.",
    );
  }

  if (
    assignment.accept_deadline_at &&
    new Date(assignment.accept_deadline_at).getTime() <= Date.now()
  ) {
    const ticketJob = await ticketJobRepository.findTicketJobById(
      assignment.vehicle_job_id,
    );
    const workerCode = account.labor_code;
    const timeoutResult = await withTransaction(async (transaction) =>
      handleAssignmentAcceptTimeout({
        assignment,
        workerId: account.id,
        connection: transaction,
      }),
    );

    if (!timeoutResult) {
      // แพ้ race ให้ accept-timeout job หรือ Admin cancel เปลี่ยนสถานะไปก่อนแล้ว — ตอบ error เดียวกับ
      // pending check ปกติ โดยไม่ต้องส่ง notification ที่จริงๆ ไม่ได้เกิดขึ้น
      throw new ApiError(
        409,
        "ASSIGNMENT_NOT_PENDING",
        "Assignment is not pending.",
      );
    }

    // แจ้ง Driver Web ว่า assignment หมดเวลา accept — เรียกหลัง transaction ข้างบน commit สำเร็จแล้วเท่านั้น
    publishDriverJobUpdate(assignment.vehicle_job_id, "DRIVER_JOB_UPDATED");

    // เรียกแยกหลัง transaction ข้างบน commit แล้วเสมอ เพราะ dispatch เขียน Redis/BullMQ ของ worker คนอื่นแยกจาก DB (ดู worker-dispatch.ts)
    try {
      await dispatchReadyWorkers();
    } catch (error) {
      logger.error("Dispatch after assignment accept-timeout failed.", {
        workerId: account.id,
        assignmentId: assignment.id,
        error,
      });
    }

    // เช่นเดียวกับ dispatchReadyWorkers — เรียก Redis queue action แยกหลัง transaction commit แล้วเสมอ
    const queue = await applyAssignmentTimeoutQueueAction(timeoutResult.queue_action, account.id);

    const ticketNos = await marketJobRepository.listActiveTicketNosByTicketJobId(
      assignment.vehicle_job_id,
    );

    sendWorkerSocketEvent(account.id, "ASSIGNMENT_TIMEOUT", {
      ticketNumber: ticketJob?.ticket_number ?? null,
      ticketNos,
      reason: timeoutResult.reason,
      timeout_count: timeoutResult.timeout_count,
      timeout_limit: timeoutResult.timeout_limit,
    });
    publishNotification({
      type: "ASSIGNMENT_TIMEOUT",
      title: "Assignment timed out",
      message: `Worker ${account.full_name} did not accept assignment ${assignment.id} in time.`,
      payload: {
        ticketNumber: ticketJob?.ticket_number ?? null,
        worker_code: workerCode,
        status: ASSIGNMENT_STATUS.TIMEOUT,
        queue: buildWorkerQueueSocketPayload(queue, workerCode),
        reason: timeoutResult.reason,
        timeout_count: timeoutResult.timeout_count,
        timeout_limit: timeoutResult.timeout_limit,
      },
      audience: {
        roles: ["admin"],
      },
    });

    throw new ApiError(
      409,
      "ASSIGNMENT_TIMEOUT",
      "Assignment acceptance time expired.",
    );
  }

  await removeAssignmentTimeout(assignment.id);
  const currentSchedule = await workScheduleRepository.findCurrentByAccountId(
    account.id,
  );

  if (currentSchedule) {
    const shiftInstanceKey = buildWorkScheduleShiftInstanceKey(currentSchedule);

    await workerCheckinLogRepository.resetAcceptTimeoutStreak({
      worker_id: account.id,
      worker_code: account.labor_code,
      schedule: currentSchedule,
      shift_instance_key: shiftInstanceKey,
    });
  }
  const settings = await getRuntimeSettings();

  // ถ้ามีเพื่อนร่วมทีม scan เข้างานแล้ว (deadline ของคนที่เหลือถูกร่นสั้นลงแล้ว ดู scanWorkerAssignment)
  // คนที่เพิ่งกดรับงานทีหลังต้องได้ deadline สั้นแบบเดียวกันทันที ไม่ใช่ deadline เต็ม
  const alreadyScannedCount = await assignmentRepository.countScannedAssignments(
    assignment.vehicle_job_id,
  );
  const scanDeadlineMinutes =
    alreadyScannedCount > 0
      ? settings.worker_scan_team_remaining_minutes
      : settings.worker_scan_deadline_minutes;

  const acceptedAssignment = await assignmentRepository.acceptAssignment(
    assignment.id,
    buildDeadline(scanDeadlineMinutes * 60 * 1000),
  );

  if (!acceptedAssignment) {
    // แพ้ race ให้ accept-timeout job หรือ Admin cancel เปลี่ยนสถานะไปก่อนระหว่างเช็ค pending กับเขียนจริง
    throw new ApiError(
      409,
      "ASSIGNMENT_NOT_PENDING",
      "Assignment is not pending.",
    );
  }

  await scheduleScanTimeout(
    acceptedAssignment.id,
    acceptedAssignment.worker_id,
    getDelayUntil(acceptedAssignment.scan_deadline_at),
  );
  await scheduleScanWarning(
    acceptedAssignment.id,
    acceptedAssignment.worker_id,
    acceptedAssignment.scan_deadline_at,
  );
  const [ticketJobDetail, team, teamScan, acceptedCount] = await Promise.all([
    ticketJobRepository.getTicketJobDetail(acceptedAssignment.vehicle_job_id),
    listTicketJobAssignmentTeamWithScanStatus(
      acceptedAssignment.vehicle_job_id,
    ),
    assignmentRepository.getTicketJobTeamScanReadiness(
      acceptedAssignment.vehicle_job_id,
    ),
    assignmentRepository.countAcceptedAssignments(
      acceptedAssignment.vehicle_job_id,
    ),
  ]);

  if (!ticketJobDetail) {
    throw new ApiError(404, "VEHICLE_JOB_NOT_FOUND", "Vehicle job not found.");
  }

  const response = buildWorkerAssignmentAcceptResponse(
    ticketJobDetail,
    team,
    acceptedAssignment,
    account.labor_code,
    account.coat_no,
    acceptedCount,
  );
  const workerCode = account.labor_code;

  sendWorkerSocketEvent(
    account.id,
    "ASSIGNMENT_ACCEPTED",
    buildAssignmentAcceptedSocketPayload(
      acceptedAssignment,
      ticketJobDetail,
      workerCode,
    ),
  );
  sendAssignmentTeamUpdatedSocketEvents(
    ticketJobDetail.vehicle_job.ticket_number,
    team,
    teamScan,
  );
  publishNotification({
    type: "ASSIGNMENT_ACCEPTED",
    title: "Assignment accepted",
    message: `Worker ${account.full_name} accepted assignment ${acceptedAssignment.id}.`,
    payload: {
      ticketNumber: ticketJobDetail.vehicle_job.ticket_number,
      worker_code: workerCode,
      status: acceptedAssignment.status,
      scan_deadline_at: acceptedAssignment.scan_deadline_at,
    },
    audience: {
      roles: ["admin"],
    },
  });

  return response;
}

// Function ตัดสินผลลัพธ์ scan ใน transaction เดียว — คืน discriminated union "expired" (QR หมดเวลา)
// หรือ "scanned" (สำเร็จ) ให้ scanWorkerAssignment แยกจัดการ side-effect ต่อตาม kind
async function resolveScanAssignmentOutcome(
  account: MasterWorkerDto,
  input: { ticket_no: string },
  teamScanRemainingMinutes: number,
  transaction: DbConnection,
) {
  // ไม่รับ TicketNumber จาก client — worker มี assignment active ได้แค่ 1 คันเสมอ จึง resolve จาก
  // assignment ปัจจุบันของ worker เองได้เลย
  const assignment = await assignmentRepository.findCurrentAssignmentByWorker(
    account.id,
    transaction,
  );

  if (!assignment) {
    throw new ApiError(404, "ASSIGNMENT_NOT_FOUND", "Assignment not found.");
  }

  // Lock แถวรถก่อนนับทีมที่สแกนแล้ว กัน write skew ตอน Worker คนสุดท้ายสองคนสแกนพร้อมกันคนละ transaction
  // (ต่างฝ่ายต่างมองไม่เห็นการสแกนของอีกฝ่าย จึงไม่มีใคร mark รถเริ่มงาน/ส่ง TEAM_READY เลย)
  await transaction.$queryRaw`SELECT id FROM ticket_jobs WHERE id = ${assignment.vehicle_job_id} FOR UPDATE`;

  if (assignment.status !== ASSIGNMENT_STATUS.ACCEPTED) {
    throw new ApiError(
      409,
      "ASSIGNMENT_NOT_ACCEPTED",
      "Assignment is not accepted.",
    );
  }

  if (isScanDeadlineExpired(assignment.scan_deadline_at)) {
    const ticketJob = await ticketJobRepository.findTicketJobById(
      assignment.vehicle_job_id,
      transaction,
    );
    const timedOutAssignment = await assignmentRepository.timeoutAssignment(
      assignment.id,
      WORKER_ASSIGNMENT_EVENT_TYPE.SCAN_TIMEOUT,
      transaction,
    );

    if (!timedOutAssignment) {
      // แพ้ race ให้ scan-timeout job หรือ Admin cancel เปลี่ยนสถานะไปก่อนระหว่างเช็ค accepted กับเขียนจริง
      throw new ApiError(
        409,
        "ASSIGNMENT_NOT_ACCEPTED",
        "Assignment is not accepted.",
      );
    }

    const teamScan = await assignmentRepository.getTicketJobTeamScanReadiness(
      assignment.vehicle_job_id,
      transaction,
    );

    if (teamScan.is_ready) {
      await ticketJobLifecycleService.markTicketJobInProgress(
        assignment.vehicle_job_id,
        transaction,
      );
    }

    return {
      kind: "expired" as const,
      timedOutAssignment,
      ticketJob,
    };
  }

  // หา Business Ticket (MarketJob) จาก barcode ticket_no ที่สแกน scope ด้วย vehicle_job_id ของ assignment ปัจจุบัน
  // ปลอดภัยแม้ ticket_no ไม่ unique ทั้งระบบ เพราะ unique แค่ภายในคันเดียว
  const scannedMarketJob = await marketJobRepository.findMarketJobByVehicleAndTicketNo(
    assignment.vehicle_job_id,
    input.ticket_no,
    transaction,
  );

  if (!scannedMarketJob) {
    throw new ApiError(
      404,
      "MARKET_JOB_NOT_FOUND",
      "Business Ticket not found for this worker's vehicle job.",
    );
  }

  const ticketJob = await ticketJobRepository.findTicketJobById(
    assignment.vehicle_job_id,
    transaction,
  );

  if (!ticketJob) {
    throw new ApiError(404, "VEHICLE_JOB_NOT_FOUND", "Vehicle job not found.");
  }

  // บันทึกไว้ใน WorkerAssignmentEvent.metadata ว่า Worker สแกน TicketNo ไหน แยกจาก assignment.scanned_at
  // ที่บอกแค่เวลา scan เข้ารถ แต่ไม่บอกว่าเลือก TicketNo ไหน
  const scannedAssignment = await assignmentRepository.scanAssignment(
    assignment.id,
    {
      ticket_no: scannedMarketJob.ticket_no,
      marketCode: scannedMarketJob.marketCode,
      marketName: scannedMarketJob.marketName,
    },
    transaction,
  );

  if (!scannedAssignment) {
    // แพ้ race ให้ scan-timeout job หรือ Admin cancel เปลี่ยนสถานะไปก่อนแล้วในช่วงเวลาสั้นๆ
    // ระหว่างที่เช็ค accepted ด้านบนกับตอนเขียนจริง
    throw new ApiError(
      409,
      "ASSIGNMENT_NOT_ACCEPTED",
      "Assignment is not accepted.",
    );
  }

  const scannedCount = await assignmentRepository.countScannedAssignments(
    assignment.vehicle_job_id,
    transaction,
  );

  const teamScan = await assignmentRepository.getTicketJobTeamScanReadiness(
    assignment.vehicle_job_id,
    transaction,
  );

  if (teamScan.is_ready) {
    await ticketJobLifecycleService.markTicketJobInProgress(
      assignment.vehicle_job_id,
      transaction,
    );
  }

  const shortenedAssignments: TicketJobAssignmentDto[] = [];

  if (
    resolveTeamReadinessThreshold(
      ticketJob.workers_required,
      ticketJob.removed_after_scan_count,
    ) > 1 &&
    scannedCount === 1
  ) {
    const remainingAssignments =
      await assignmentRepository.listAcceptedAssignmentsByTicketJob(
        assignment.vehicle_job_id,
        { excludedAssignmentId: assignment.id },
        transaction,
      );
    const teamScanDeadline = buildDeadline(
      teamScanRemainingMinutes * 60 * 1000,
    );

    for (const remainingAssignment of remainingAssignments) {
      shortenedAssignments.push(
        await assignmentRepository.updateAssignmentScanDeadline(
          remainingAssignment.id,
          teamScanDeadline,
          transaction,
        ),
      );
    }
  }

  return {
    kind: "scanned" as const,
    scannedAssignment,
    ticketJob,
    scannedMarketJob,
    shortenedAssignments,
    teamScan,
  };
}

// Function จัดการ side-effect เมื่อ QR scan หมดเวลา (คืน Worker เข้าคิว + แจ้งเตือน) แล้ว throw
// ปิดท้ายเสมอ — ไม่มี "response สำเร็จ" ให้คืนสำหรับ outcome นี้
async function handleExpiredScanOutcome(
  result: Extract<Awaited<ReturnType<typeof resolveScanAssignmentOutcome>>, { kind: "expired" }>,
  account: MasterWorkerDto,
): Promise<never> {
  await removeScanTimeout(result.timedOutAssignment.id);
  await removeScanWarning(result.timedOutAssignment.id);
  const queue = await markWorkerOpenApp(account.id, WORKER_OPEN_APP_REASON.SCAN_TIMEOUT);

  // dispatch เป็น best-effort เสมอ — ต้องไม่ทำให้ scan-timeout ที่จัดการสำเร็จไปแล้วพัง 500 เพราะ
  // dispatch worker คันอื่นล้มเหลว (เขียน Redis/BullMQ แยกจาก DB transaction ของ request นี้)
  try {
    await dispatchReadyWorkers();
  } catch (error) {
    logger.error("Worker scan timed out but requeue dispatch failed.", {
      workerId: account.id,
      error,
    });
  }
  const workerCode = account.labor_code;
  const ticketNos = await marketJobRepository.listActiveTicketNosByTicketJobId(
    result.timedOutAssignment.vehicle_job_id,
  );

  sendWorkerSocketEvent(account.id, "ASSIGNMENT_TIMEOUT", {
    ticketNumber: result.ticketJob?.ticket_number ?? null,
    ticketNos,
    reason: "scan_timeout",
    status: WORKER_WORK_STATUS.OPEN_APP,
  });
  publishNotification({
    type: "ASSIGNMENT_TIMEOUT",
    title: "Assignment scan timed out",
    message: `Worker ${account.full_name} did not scan QR in time.`,
    payload: {
      ticketNumber: result.ticketJob?.ticket_number ?? null,
      worker_code: workerCode,
      status: result.timedOutAssignment.status,
      reason: "scan_timeout",
      queue: buildWorkerQueueSocketPayload(queue, workerCode),
    },
    audience: {
      roles: ["admin"],
    },
  });
  // แจ้ง WORKER_STATUS_CHANGED แยกจาก ASSIGNMENT_TIMEOUT ด้านบนด้วย ให้ตรง pattern เดียวกับจุดอื่นที่
  // worker กลับไป open_app (เช่น handleAssignmentScanTimeout ฝั่ง worker-dispatch.ts ที่ path นี้ไม่ได้ผ่าน
  // เพราะเป็นคนละ entry point — ฝั่งนี้ worker เรียก API เองมาเจอว่าหมดเวลาไปแล้ว)
  publishAdminWorkerStatusChanged({
    title: "Worker moved to open_app",
    message: `Worker ${workerCode ?? account.id} moved to open_app after QR scan timed out.`,
    workerCode,
    queue,
    reason: "scan_timeout",
  });

  throw new ApiError(409, "QR_EXPIRED", "Worker QR scan time expired.");
}

// Function จัดการ side-effect เมื่อ scan สำเร็จ (schedule timeout ใหม่, แจ้งเตือน, ประกาศ realtime)
// แล้วสร้าง response กลับให้ worker
async function buildScannedOutcomeResponse(
  result: Extract<Awaited<ReturnType<typeof resolveScanAssignmentOutcome>>, { kind: "scanned" }>,
  account: MasterWorkerDto,
  teamScanRemainingMinutes: number,
): Promise<WorkerAssignmentCheckInResponse> {
  const { scannedAssignment, ticketJob, scannedMarketJob, shortenedAssignments, teamScan } =
    result;
  await removeScanTimeout(scannedAssignment.id);
  await removeScanWarning(scannedAssignment.id);
  await Promise.all(
    shortenedAssignments.flatMap((assignment) => [
      scheduleScanTimeout(
        assignment.id,
        assignment.worker_id,
        getDelayUntil(assignment.scan_deadline_at),
      ),
      scheduleScanWarning(
        assignment.id,
        assignment.worker_id,
        assignment.scan_deadline_at,
      ),
    ]),
  );
  const workerCode = account.labor_code;

  if (shortenedAssignments.length > 0) {
    const [firstShortenedAssignment] = shortenedAssignments;
    const shortenedTicketNos = await marketJobRepository.listActiveTicketNosByTicketJobId(
      ticketJob.id,
    );

    publishRealtimeEvent({
      type: "ASSIGNMENT_SCAN_DEADLINE_SHORTENED",
      title: "Scan deadline shortened",
      message: `Remaining workers must scan QR within ${teamScanRemainingMinutes} minutes for vehicle job ${ticketJob.ticket_number}.`,
      payload: {
        ticketNumber: ticketJob.ticket_number,
        remaining_minutes: teamScanRemainingMinutes,
        scan_deadline_at: firstShortenedAssignment.scan_deadline_at,
        scan_deadline_unix_ms: toUnixMs(firstShortenedAssignment.scan_deadline_at),
        assignment_count: shortenedAssignments.length,
      },
      worker_payload: {
        ticketNumber: ticketJob.ticket_number,
        ticketNos: shortenedTicketNos,
        remaining_minutes: teamScanRemainingMinutes,
        scan_deadline_at: firstShortenedAssignment.scan_deadline_at,
        scan_deadline_unix_ms: toUnixMs(firstShortenedAssignment.scan_deadline_at),
      },
      admin: true,
      worker_ids: shortenedAssignments.map(
        (assignment) => assignment.worker_id,
      ),
    });
  }
  await notifyTicketJobTeamScanReadiness(ticketJob, teamScan);

  publishNotification({
    type: "ASSIGNMENT_CHECKED_IN",
    title: "Assignment checked in",
    message: `Worker ${account.full_name} checked in assignment ${scannedAssignment.id}.`,
    payload: {
      ticketNumber: ticketJob.ticket_number,
      worker_code: workerCode,
      status: scannedAssignment.status,
      scanned_at: scannedAssignment.scanned_at,
    },
    audience: {
      roles: ["admin"],
    },
  });

  return {
    status: scannedAssignment.status,
    worker_status: resolveWorkerWorkStatus(null, scannedAssignment, teamScan),
    worker_code: workerCode,
    ticket_number: ticketJob.ticket_number,
    ticket_no: scannedMarketJob.ticket_no,
    team_scan: buildWorkerTeamScanResponse(teamScan),
  };
}

// Function จัดการ worker สแกน barcode เข้ารับงาน ใน service flow
export async function scanWorkerAssignment(
  body: unknown,
  auth?: AccessTokenPayload,
): Promise<WorkerAssignmentCheckInResponse> {
  const account = await requireWorker(auth);
  const input = parseWithSchema(workerCheckInBarcodeBodySchema, body);
  const settings = await getRuntimeSettings();
  const teamScanRemainingMinutes = settings.worker_scan_team_remaining_minutes;

  const result = await withTransaction((transaction) =>
    resolveScanAssignmentOutcome(account, input, teamScanRemainingMinutes, transaction),
  );

  // แจ้ง Driver Web ว่าทีมสแกน/timeout เปลี่ยน (อาจตั้ง WorkStartedAt ด้วยถ้าทีมครบพอดี) — เรียกหลัง
  // transaction ข้างบน commit สำเร็จแล้วเท่านั้น
  if (result.ticketJob) {
    publishDriverJobUpdate(result.ticketJob.id, "DRIVER_JOB_UPDATED");
  }

  if (result.kind === "expired") {
    return handleExpiredScanOutcome(result, account);
  }

  return buildScannedOutcomeResponse(result, account, teamScanRemainingMinutes);
}

// Function Worker ส่งยอดปิด Booth — ticket_no/boothCode มาจาก body ส่วน TicketNumber resolve จาก assignment
// ปัจจุบันของ worker เอง (ไม่รับจาก client) TicketNo ยังต้องส่งมาเพราะ boothCode ไม่ unique ข้าม Business Ticket
export async function completeWorkerAssignmentTicketFromBody(
  body: unknown,
  auth?: AccessTokenPayload,
): Promise<TicketCompletionResponse> {
  const account = await requireWorker(auth);
  const input = parseWithSchema(workerTicketCompleteBodySchema, body);
  const result = await withTransaction((transaction) =>
    ticketCompletionService.submitTicketCompletion({
      findTicket: (connection) =>
        requireBoothJobForCompletionByCurrentAssignment(
          account.id,
          input.ticket_no,
          input.boothCode,
          connection,
        ),
      items: input.items,
      submittedByAccountId: account.id,
      submittedByRole: TICKET_SUBMITTER_ROLE.WORKER,
      requireRosterMembership: true,
      connection: transaction,
    }),
  );
  const currentScheduleAfterSubmit =
    await workScheduleRepository.findCurrentByAccountId(account.id);

  if (
    !currentScheduleAfterSubmit ||
    !isTimeInWorkSchedule(currentScheduleAfterSubmit)
  ) {
    if (currentScheduleAfterSubmit) {
      const shiftInstanceKey = buildWorkScheduleShiftInstanceKey(
        currentScheduleAfterSubmit,
      );

      await closeWorkerAttendanceShift(
        account,
        currentScheduleAfterSubmit,
        shiftInstanceKey,
        "ticket_delivered_after_shift_end",
      );
    }
    const queue = await markWorkerOpenApp(account.id);

    if (isWorkerSocketConnected(account.id)) {
      sendWorkerSocketEvent(account.id, "WORKER_STATUS_CHANGED", {
        queue: buildWorkerQueueSocketPayload(queue, account.labor_code),
        reason: "ticket_delivered_after_shift_end",
      });
    }
    publishAdminWorkerStatusChanged({
      title: "Worker moved to open_app",
      message: `Worker ${account.full_name} moved to open_app after submitting ticket completion outside the shift.`,
      workerCode: account.labor_code,
      queue,
      reason: "ticket_delivered_after_shift_end",
    });
  }
  // แจ้ง Driver Web ว่าแผงถูกส่งยอดแล้ว — เรียกหลัง transaction ข้างบน commit สำเร็จแล้วเท่านั้น
  publishDriverJobUpdate(result.ticket.vehicle_job_id, "DRIVER_JOB_UPDATED");

  // Ticket ถูก commit เป็น DELIVERED ไปแล้วจริงจาก submitTicketCompletion ด้านบน — ถ้า notify vendor
  // ต่อไปนี้ fail ต้อง best-effort เท่านั้น ห้าม throw ทำให้ request ตอบ error ทั้งที่ยอดบันทึกสำเร็จแล้ว
  let detail: TicketJobDetailResponse | null = null;

  try {
    ({ detail } = await ticketCompletionService.notifyTicketCompletionSubmitted(result));
  } catch (error) {
    logger.error("Failed to notify vendor after ticket completion was submitted.", {
      ticketId: result.ticket.id,
      submissionId: result.submission.id,
      error,
    });
  }

  // Best-effort เช่นกัน — ถ้าทุก Booth เสร็จครบแล้วและมี Worker ในทีมหมดกะไปแล้ว ให้ปล่อยทั้งทีมกลับคิวทันที
  // โดยไม่ต้องรอ Admin กด release-workers เพิ่ม
  try {
    const ticketJob = await ticketJobRepository.findTicketJobById(
      result.ticket.vehicle_job_id,
    );

    if (ticketJob) {
      await autoReleaseTicketJobWorkersIfShiftEnded(ticketJob, account.id);
    }
  } catch (error) {
    logger.error("Failed to auto-release vehicle job workers after worker ticket completion.", {
      ticketJobId: result.ticket.vehicle_job_id,
      error,
    });
  }

  const responsePayload = buildWorkerTicketPayload(
    result.ticket,
    detail,
    result.products,
    {
      submission_status: result.submission.status,
      assignment_status: ASSIGNMENT_STATUS.DELIVERED,
      confirmed_at: result.submission.confirmed_at,
      rejected_at: result.submission.rejected_at,
      ticket_completed_at: null,
    },
  ) as Omit<TicketCompletionResponse, "message">;

  return {
    message: "Ticket completion submitted and waiting for vendor confirmation.",
    ...responsePayload,
  };
}
