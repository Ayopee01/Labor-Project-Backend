// Import Library
import { Prisma } from "@prisma/client";
import type { WorkerCheckinLog } from "@prisma/client";
// Import Config
import { withTransaction } from "../db/prisma";
import { EMPTY_SECURITY_AUDIT_CONTEXT } from "../config/security-audit.config";
import type { RuntimeSettings } from "../config/runtime.config";
import { ASSIGNMENT_STATUS, WORKER_OPEN_APP_REASON } from "../constants/status";
import { DEFAULT_PAGE_LIMIT } from "../constants/pagination";
// Import Repositories
import * as adminWorkersRepository from "../repositories/admin-workers.repository";
import * as accountRepository from "../repositories/shared/account.repository";
import * as adminActionLogRepository from "../repositories/shared/admin-action-log.repository";
import * as masterWorkerRepository from "../repositories/shared/master-worker.repository";
import * as assignmentRepository from "../repositories/shared/ticket-job-assignment.repository";
import * as ticketJobRepository from "../repositories/shared/ticket-job.repository";
import * as workerCheckinLogRepository from "../repositories/shared/worker-checkin-log.repository";
import * as workerSessionRepository from "../repositories/shared/worker-session.repository";
// Import Services
import { getRuntimeSettings } from "./shared/runtime-settings.service";
import { closeWorkerAttendanceShift, closeWorkerBreakLog, reopenWorkerAttendanceShift, scheduleWorkerShiftEndIfNeeded, startWorkerBreakLog } from "./shared/worker-attendance.service";
import { publishAdminWorkerStatusChanged } from "./notifications.service";
import { writeSecurityAuditLog, diffChangedFields } from "./shared/security-audit-log.service";
// Import Queues
import { enqueueWorker, getWorkerBreakCount, getWorkerPresence, getWorkerPresences, getWorkerQueueStatus, getWorkerQueueStatuses, getWorkerReadyQueueRanks, incrementWorkerBreakCount, markWorkerBreak, markWorkerOpenApp, removeWorkerBreakReturn, scheduleWorkerBreakReturn } from "../queues/worker-queue";
import { dispatchReadyWorkers } from "../queues/worker-dispatch";
// Import Websockets
import { disconnectWorkerSocket, isWorkerSocketConnected, sendWorkerSocketEvent } from "../websockets/worker.socket";
// Import Types
import { SECURITY_AUDIT_EVENT_TYPE, SECURITY_AUDIT_OUTCOME } from "../types/shared/security-audit-log.type";
import type { AccessTokenPayload } from "../types/auth.type";
import type { AccountStatus } from "../types/shared/account.type";
import type { DbConnection } from "../types/shared/common.type";
import { MASTER_WORKER_STATUS } from "../types/admin-workers.type";
import type { AdminWorkerBoardStatus, AdminWorkerStatusItem, MasterWorkerDto, PaginationMeta, UserDetailResponse, UserListItem, UserListFilters, UserListSchedule, WorkScheduleDto } from "../types/admin-workers.type";
import type { TicketJobAssignmentDto, VehicleWorkReadinessDto, WorkerPresenceDto, WorkerQueueEntryDto } from "../types/worker.type";
import type { SecurityAuditRequestContext } from "../types/shared/security-audit-log.type";
import { WORKER_WORK_STATUS } from "../types/shared/worker-status.type";
import { ADMIN_ACTION_TYPE } from "../types/shared/admin-action-log.type";
// Import Validation
import { parseWithSchema } from "../validation/parser";
import { adminForceWorkerStatusBodySchema, createUserBodySchema, optionalPaginationQuerySchema, paginationQuerySchema, resetPasswordBodySchema, updateUserBodySchema } from "../validation/schemas";
// Import Utils
import { requireActorId } from "../utils/actor";
import ApiError from "../utils/api-error";
import { logger } from "../utils/logger";
import { hashPassword, normalizePhoneDigits } from "../utils/password";
import { buildShiftWaitInfo, buildWorkScheduleShiftInstanceKey, isTimeInWorkSchedule } from "../utils/shift";
import { buildDeadline, formatBangkokDate, toUnixMs } from "../utils/time";
import { buildWorkerQueueSocketPayload } from "../utils/worker-payload";
import { buildWorkerCode } from "../utils/worker-code";
import { resolveShiftActiveStatus, resolveWorkerWorkStatus } from "../utils/worker-status";
import { resolveShiftInactiveReasonText } from "../utils/shift-status-localization";

/* -------------------------------------- Functions -------------------------------------- */

// Function สร้าง payload งานปัจจุบันของ worker สำหรับส่งทาง socket
async function buildWorkerAssignmentSocketPayload(
  assignment: TicketJobAssignmentDto | null
) {
  if (!assignment) {
    return null;
  }

  const ticketJob = await ticketJobRepository.findTicketJobById(
    assignment.vehicle_job_id
  );

  return {
    ticketNumber: ticketJob?.ticket_number ?? null,
    status: assignment.status,
    accept_deadline_at: assignment.accept_deadline_at,
    scan_deadline_at: assignment.scan_deadline_at,
    accepted_at: assignment.accepted_at,
    scanned_at: assignment.scanned_at,
    completed_at: assignment.completed_at,
  };
}

// Function ดึง worker ตาม id (ไม่พบ throw 404)
async function requireWorker(
  id: number | string,
  connection?: DbConnection
): Promise<MasterWorkerDto> {
  const worker =
    typeof id === "number"
      ? await masterWorkerRepository.findById(id, connection)
      : await adminWorkersRepository.findByIdentifier(id, connection);

  if (!worker) {
    throw new ApiError(404, "WORKER_NOT_FOUND", `Worker ${id} not found.`);
  }

  return worker;
}

// Function สร้างข้อมูลแบ่งหน้า (page/limit/total)
function buildPaginationMeta(
  page: number,
  limit: number,
  total: number
): PaginationMeta {
  return {
    page,
    limit,
    total,
    total_pages: Math.ceil(total / limit),
  };
}

// Function จัดรูปแบบกะของ worker สำหรับรายการ
function formatUserListSchedule(
  schedule: WorkScheduleDto | null
): UserListSchedule | null {
  if (!schedule) {
    return null;
  }

  return {
    shift_name: schedule.shift_name,
    time_in: schedule.time_in,
    time_out: schedule.time_out,
  };
}

// Function แปลงสถานะตัวเลขของ MasterWorker เป็น active/inactive
function toAccountStatus(status: number | null): AccountStatus {
  return status === MASTER_WORKER_STATUS.ACTIVE ? "active" : "inactive";
}

// Function จัดรูปแบบ worker หนึ่งคนสำหรับรายการ
function formatUserListItem(worker: MasterWorkerDto): UserListItem {
  const schedule = scheduleFromWorker(worker);

  return {
    worker_code: worker.labor_code,
    labor_color: worker.labor_color,
    shirt_number: worker.coat_no,
    full_name: worker.full_name,
    phone: worker.telephone,
    work_start_date: worker.work_start_date,
    work_schedule: formatUserListSchedule(schedule),
    status: toAccountStatus(worker.status),
    updated_at: worker.updated_at,
  };
}

// Function สร้าง WorkScheduleDto จาก field shift บน MasterWorker เอง (schedule ไม่ใช่ entity แยก)
function scheduleFromWorker(worker: MasterWorkerDto): WorkScheduleDto | null {
  if (
    worker.shift_name === null ||
    worker.time_in === null ||
    worker.time_out === null
  ) {
    return null;
  }

  return {
    id: worker.id,
    worker_id: worker.id,
    shift_name: worker.shift_name,
    work_date: worker.work_start_date ?? worker.created_at.slice(0, 10),
    time_in: worker.time_in,
    time_out: worker.time_out,
    is_current: true,
    created_by: null,
    updated_by: null,
    created_at: worker.created_at,
    updated_at: worker.updated_at,
  };
}

// Function จัดรูปแบบรายละเอียด worker
function formatUserDetail(worker: MasterWorkerDto): UserDetailResponse {
  const schedule = scheduleFromWorker(worker);

  return {
    image_url: worker.image_url,
    worker_code: worker.labor_code,
    full_name: worker.full_name,
    status: toAccountStatus(worker.status),
    details: {
      phone: worker.telephone,
      nationality: worker.nationality,
      labor_color: worker.labor_color,
      work_start_date: worker.work_start_date,
      shift_name: schedule?.shift_name ?? null,
      time_in: schedule?.time_in ?? null,
      time_out: schedule?.time_out ?? null,
    },
  };
}

// Function ตรวจว่า WorkerCode ยังไม่ถูกใช้
async function assertWorkerCodeAvailable(
  workerCode: string,
  exceptWorkerId?: number | null,
  connection?: DbConnection
): Promise<void> {
  const exists = await adminWorkersRepository.laborCodeExists(
    workerCode,
    exceptWorkerId,
    connection
  );

  if (exists) {
    throw new ApiError(
      409,
      "WORKER_CODE_ALREADY_EXISTS",
      "Worker code already exists."
    );
  }
}

// Function แปลง P2002 ของ laborCode ซ้ำเป็น ApiError 409 (กันสอง request สร้างรหัสเดียวกันพร้อมกัน)
function rethrowAsWorkerCodeConflict(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    throw new ApiError(
      409,
      "WORKER_CODE_ALREADY_EXISTS",
      "Worker code already exists."
    );
  }

  throw error;
}

// Function ตรวจว่าเบอร์โทรที่ตัดอักขระแล้วยังมีตัวเลข (ไม่งั้น throw 400)
function assertNormalizedPhoneHasDigits(normalizedPhone: string): void {
  if (!normalizedPhone) {
    throw new ApiError(
      400,
      "INVALID_PHONE",
      "Phone number must contain at least one digit."
    );
  }
}

// Function revoke session ของ worker พร้อมย้ายออกจากคิวเป็น open_app และปิดกะ
async function revokeWorkerSessions(
  worker: MasterWorkerDto,
  connection?: DbConnection
): Promise<void> {
  await workerSessionRepository.revokeActiveByWorkerId(worker.id, connection);

  const [currentQueueEntry, currentAssignment] = await Promise.all([
    getWorkerQueueStatus(worker.id),
    assignmentRepository.findCurrentAssignmentByWorker(worker.id),
  ]);
  // ต้องใช้ความพร้อมของทีมด้วย ไม่งั้นสถานะจะเป็น WORKING ทั้งที่ทีมยังมาไม่ครบ
  const currentTeamScan = currentAssignment
    ? await assignmentRepository.getTicketJobTeamScanReadiness(
        currentAssignment.vehicle_job_id
      )
    : null;

  if (
    currentQueueEntry &&
    currentQueueEntry.status !== WORKER_WORK_STATUS.OPEN_APP
  ) {
    const currentSchedule = scheduleFromWorker(worker);

    if (currentQueueEntry.status === WORKER_WORK_STATUS.BREAK && currentSchedule) {
      await removeWorkerBreakReturn(worker.id, currentSchedule.id);
    }

    if (currentSchedule) {
      const shiftInstanceKey = buildWorkScheduleShiftInstanceKey(currentSchedule);

      await closeWorkerAttendanceShift(
        worker,
        currentSchedule,
        shiftInstanceKey,
        "admin_session_revoked",
        connection
      );
    }

    const queueEntry = await markWorkerOpenApp(worker.id);

    sendWorkerSocketEvent(worker.id, "WORKER_STATUS_CHANGED", {
      queue: buildWorkerQueueSocketPayload(
        queueEntry,
        worker.labor_code,
        currentAssignment,
        currentTeamScan
      ),
      reason: "admin_session_revoked",
    });
    publishAdminWorkerStatusChanged({
      title: "Worker session revoked",
      message: `Worker ${worker.full_name} was moved to open_app after admin revoked their session.`,
      workerCode: worker.labor_code,
      queue: queueEntry,
      assignment: currentAssignment,
      team_scan_readiness: currentTeamScan,
      reason: "admin_session_revoked",
    });
  }

  // ปิด socket และล้าง presence เสมอ แม้สถานะคิวเป็น open_app อยู่แล้ว
  try {
    await disconnectWorkerSocket(worker.id, "admin_session_revoked");
  } catch (error) {
    logger.error(
      "Failed to disconnect worker socket after admin revoked session.",
      { error, accountId: worker.id },
    );
  }
}

// Function สร้าง worker ใหม่ พร้อม password จากเบอร์โทร
export async function createUser(
  body: unknown,
  auth?: AccessTokenPayload,
  context: SecurityAuditRequestContext = EMPTY_SECURITY_AUDIT_CONTEXT
) {
  const actorId = requireActorId(auth);
  const {
    username: requestedUsername,
    full_name: fullName,
    phone,
    nationality,
    shirt_type: shirtType,
    shirt_number: shirtNumber,
    work_start_date: workStartDate,
    shift_name: shiftName,
    time_in: timeIn,
    time_out: timeOut,
    status,
  } = parseWithSchema(createUserBodySchema, body);
  const workerCode = buildWorkerCode({
    nationality,
    shirt_type: shirtType,
    shirt_number: shirtNumber,
  });
  const laborCode = requestedUsername ?? workerCode;
  const initialWorkStartDate = workStartDate ?? formatBangkokDate();
  // เก็บเบอร์เป็นตัวเลขล้วน และใช้ค่าเดียวกันสร้าง password
  const normalizedPhone = normalizePhoneDigits(phone);
  assertNormalizedPhoneHasDigits(normalizedPhone);
  // work_code ใช้เลขเสื้อตรงๆ ให้ตรงกับ master data
  const workCode = Number(shirtNumber);

  return withTransaction(async (transaction) => {
    await assertWorkerCodeAvailable(laborCode, null, transaction);

    try {
      await adminWorkersRepository.create(
        {
          labor_code: laborCode,
          full_name: fullName,
          telephone: normalizedPhone,
          nationality,
          labor_color: shirtType,
          work_start_date: initialWorkStartDate,
          work_code: workCode,
          coat_no: shirtNumber,
          shift_name: shiftName,
          time_in: timeIn,
          time_out: timeOut,
          status: status === "active" ? MASTER_WORKER_STATUS.ACTIVE : MASTER_WORKER_STATUS.INACTIVE,
        },
        transaction
      );
    } catch (error) {
      rethrowAsWorkerCodeConflict(error);
    }

    const passwordHash = await hashPassword(normalizedPhone);
    const created = await adminWorkersRepository.findByIdentifier(laborCode, transaction);

    if (created) {
      await masterWorkerRepository.updatePasswordHash(created.id, passwordHash, transaction);
    }

    const actor = await accountRepository.findById(actorId, transaction);

    await writeSecurityAuditLog(
      {
        event_type: SECURITY_AUDIT_EVENT_TYPE.WORKER_ACCOUNT_CREATED,
        outcome: SECURITY_AUDIT_OUTCOME.SUCCESS,
        actor_type: "admin",
        actor_account_id: actorId,
        actor_username: actor?.username ?? null,
        actor_full_name: actor?.full_name ?? null,
        ip_address: context.ip_address,
        user_agent: context.user_agent,
        request_id: context.request_id,
        metadata: {
          targetType: "worker",
          targetWorkerId: created?.id ?? null,
          targetWorkerCode: laborCode,
          after: {
            full_name: fullName,
            status,
            shift_name: shiftName,
            time_in: timeIn,
            time_out: timeOut,
          },
        },
      },
      transaction
    );

    return {
      message: "Worker created successfully.",
    };
  });
}

// Function ดึงรายการ worker แบบแบ่งหน้าและกรองได้
export async function listUsers(
  query: Record<string, unknown> = {},
  _auth?: AccessTokenPayload
) {
  const { page, limit, search, status, worker_code, full_name, shirt_number, shift } = parseWithSchema(
    paginationQuerySchema,
    query
  );
  const filters: UserListFilters = {
    status,
    search,
    worker_code,
    full_name,
    shirt_number,
    shift,
    offset: (page - 1) * limit,
    limit,
  };
  const [users, total] = await Promise.all([
    adminWorkersRepository.listUsers(filters),
    adminWorkersRepository.countUsers(filters),
  ]);
  const data = users.map((user) => formatUserListItem(user));

  return {
    data,
    pagination: buildPaginationMeta(page, limit, total),
  };
}

// Function ดึงรายละเอียด worker
export async function getUser(id: number | string, _auth?: AccessTokenPayload) {
  const worker = await requireWorker(id);

  return formatUserDetail(worker);
}

// Function แก้ไข worker (สร้าง worker_code ใหม่เมื่อส่งสัญชาติ ประเภทเสื้อ และเลขเสื้อมาครบ)
export async function updateUser(
  id: number | string,
  body: unknown,
  auth?: AccessTokenPayload,
  context: SecurityAuditRequestContext = EMPTY_SECURITY_AUDIT_CONTEXT
) {
  const actorId = requireActorId(auth);
  const {
    worker_code: requestedWorkerCode,
    full_name: nextFullName,
    phone,
    nationality,
    shirt_type: shirtType,
    shirt_number: shirtNumber,
    work_start_date: workStartDate,
    shift_name: shiftName,
    time_in: timeIn,
    time_out: timeOut,
    status,
  } = parseWithSchema(updateUserBodySchema, body);
  const hasScheduleTimeInput =
    timeIn !== undefined || timeOut !== undefined;
  const hasShiftInput = shiftName !== undefined || hasScheduleTimeInput;
  // เก็บ telephone ลง DB เป็นตัวเลขล้วนเสมอเช่นเดียวกับตอนสร้าง (undefined = ไม่ได้แก้เบอร์)
  const normalizedPhone = phone !== undefined ? normalizePhoneDigits(phone) : undefined;

  if (normalizedPhone !== undefined) {
    assertNormalizedPhoneHasDigits(normalizedPhone);
  }

  const { result, updatedWorker } = await withTransaction(async (transaction) => {
    const worker = await requireWorker(id, transaction);
    // เก็บค่าก่อนแก้ไว้เทียบ before/after
    const workerBeforeUpdate = { ...worker };
    const nextWorkerCode =
      requestedWorkerCode ??
      (nationality !== undefined && shirtType !== undefined && shirtNumber !== undefined
        ? buildWorkerCode({ nationality, shirt_type: shirtType, shirt_number: shirtNumber })
        : undefined);

    if (nextWorkerCode !== undefined) {
      await assertWorkerCodeAvailable(nextWorkerCode, worker.id, transaction);
    }

    const hasFieldUpdates =
      nextWorkerCode !== undefined ||
      (nextFullName !== undefined && nextFullName !== "") ||
      phone !== undefined ||
      nationality !== undefined ||
      shirtType !== undefined;

    if (hasFieldUpdates) {
      try {
        await adminWorkersRepository.update(
          worker.id,
          {
            labor_code: nextWorkerCode,
            full_name: nextFullName !== undefined && nextFullName !== "" ? nextFullName : undefined,
            telephone: normalizedPhone,
            nationality,
            labor_color: shirtType,
          },
          transaction
        );
      } catch (error) {
        rethrowAsWorkerCodeConflict(error);
      }

      if (normalizedPhone !== undefined) {
        await masterWorkerRepository.updatePasswordHash(
          worker.id,
          await hashPassword(normalizedPhone),
          transaction
        );
      }
    }

    if (workStartDate !== undefined) {
      await adminWorkersRepository.update(worker.id, { work_start_date: workStartDate }, transaction);
    }

    if (status !== undefined) {
      await adminWorkersRepository.update(
        worker.id,
        { status: status === "active" ? MASTER_WORKER_STATUS.ACTIVE : MASTER_WORKER_STATUS.INACTIVE },
        transaction
      );

      if (status === "inactive") {
        await revokeWorkerSessions(worker, transaction);
      }
    }

    if (hasShiftInput) {
      if (hasScheduleTimeInput && (timeIn === undefined || timeOut === undefined)) {
        throw new ApiError(
          400,
          "TIME_PAIR_REQUIRED",
          "TimeIn and TimeOut must be sent together."
        );
      }

      // ตั้งเวลากะให้ worker ที่ยังไม่มีชื่อกะ ต้องส่ง ShiftName มาด้วย
      if (hasScheduleTimeInput && shiftName === undefined && worker.shift_name === null) {
        throw new ApiError(
          400,
          "SHIFT_NAME_REQUIRED",
          "ShiftName is required when setting TimeIn and TimeOut for a worker without a shift name."
        );
      }

      await adminWorkersRepository.updateShift(
        worker.id,
        {
          shift_name: shiftName,
          time_in: timeIn,
          time_out: timeOut,
          work_start_date: workStartDate,
        },
        transaction
      );
    }

    const updatedWorker = await requireWorker(worker.id, transaction);
    const diff = diffChangedFields(workerBeforeUpdate, updatedWorker, [
      "labor_code",
      "full_name",
      "telephone",
      "nationality",
      "labor_color",
      "work_start_date",
      "status",
      "shift_name",
      "time_in",
      "time_out",
    ]);

    if (diff) {
      const actor = await accountRepository.findById(actorId, transaction);

      await writeSecurityAuditLog(
        {
          event_type: SECURITY_AUDIT_EVENT_TYPE.WORKER_ACCOUNT_UPDATED,
          outcome: SECURITY_AUDIT_OUTCOME.SUCCESS,
          actor_type: "admin",
          actor_account_id: actorId,
          actor_username: actor?.username ?? null,
          actor_full_name: actor?.full_name ?? null,
          ip_address: context.ip_address,
          user_agent: context.user_agent,
          request_id: context.request_id,
          metadata: {
            targetType: "worker",
            targetWorkerId: worker.id,
            targetWorkerCode: updatedWorker.labor_code,
            before: diff.before,
            after: diff.after,
          },
        },
        transaction
      );
    }

    return { result: formatUserDetail(updatedWorker), updatedWorker };
  });

  // แก้เวลากะแล้วตั้ง job จบกะใหม่ (best-effort)
  if (hasScheduleTimeInput) {
    const updatedSchedule = scheduleFromWorker(updatedWorker);

    if (updatedSchedule) {
      try {
        await scheduleWorkerShiftEndIfNeeded(updatedWorker.id, updatedSchedule);
      } catch (error) {
        logger.error("Failed to re-arm worker shift-end job after admin updated shift time.", {
          workerId: updatedWorker.id,
          error,
        });
      }
    }
  }

  return result;
}

// Function reset password ของ worker (ถูกเขียนทับอีกครั้งเมื่อเบอร์โทรเปลี่ยน)
export async function resetPassword(
  id: number | string,
  body: unknown,
  auth?: AccessTokenPayload,
  context: SecurityAuditRequestContext = EMPTY_SECURITY_AUDIT_CONTEXT
) {
  const actorId = requireActorId(auth);
  const { new_password: newPassword } = parseWithSchema(
    resetPasswordBodySchema,
    body
  );

  return withTransaction(async (transaction) => {
    const worker = await requireWorker(id, transaction);
    const actor = await accountRepository.findById(actorId, transaction);

    await masterWorkerRepository.updatePasswordHash(
      worker.id,
      await hashPassword(newPassword),
      transaction
    );
    await revokeWorkerSessions(worker, transaction);

    await writeSecurityAuditLog(
      {
        event_type: SECURITY_AUDIT_EVENT_TYPE.ACCOUNT_PASSWORD_RESET,
        outcome: SECURITY_AUDIT_OUTCOME.SUCCESS,
        actor_type: "admin",
        actor_account_id: actorId,
        actor_username: actor?.username ?? null,
        actor_full_name: actor?.full_name ?? null,
        ip_address: context.ip_address,
        user_agent: context.user_agent,
        request_id: context.request_id,
        metadata: {
          targetType: "worker",
          targetWorkerId: worker.id,
          targetWorkerCode: worker.labor_code,
        },
      },
      transaction
    );

    return {
      message: "Password reset successfully.",
    };
  });
}

// Function เลือกเวลาล่าสุดจากหลายค่า
function latestTimestamp(values: Array<string | null | undefined>): string | null {
  const timestamps = values
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter((value) => !Number.isNaN(value));

  if (timestamps.length === 0) {
    return null;
  }

  return new Date(Math.max(...timestamps)).toISOString();
}

// Config ลำดับการเรียงสถานะ worker บนบอร์ด Admin
const ADMIN_WORKER_STATUS_ORDER: Record<AdminWorkerBoardStatus, number> = {
  [WORKER_WORK_STATUS.OPEN_APP]: 0,
  [WORKER_WORK_STATUS.READY]: 1,
  [WORKER_WORK_STATUS.ASSIGNED]: 2,
  [WORKER_WORK_STATUS.WAITING_TEAM]: 3,
  [WORKER_WORK_STATUS.WORKING]: 4,
  [WORKER_WORK_STATUS.BREAK]: 5,
};

// Function แปลงเวลาเป็นตัวเลขสำหรับเรียงลำดับ
function timestampToSortValue(value: string | null): number {
  if (!value) {
    return Number.POSITIVE_INFINITY;
  }

  const timestamp = new Date(value).getTime();

  return Number.isNaN(timestamp) ? Number.POSITIVE_INFINITY : timestamp;
}

// Function หาเวลาที่ worker เข้าสู่สถานะปัจจุบัน
function resolveStatusEnteredAt(
  status: AdminWorkerBoardStatus,
  queue: WorkerQueueEntryDto | null,
  assignment: TicketJobAssignmentDto | null,
  presence: WorkerPresenceDto
): string | null {
  if (status === WORKER_WORK_STATUS.READY) {
    return queue?.ready_at ?? queue?.updated_at ?? presence.last_seen_at;
  }

  if (status === WORKER_WORK_STATUS.ASSIGNED) {
    return assignment?.accepted_at ?? assignment?.created_at ?? queue?.updated_at ?? presence.last_seen_at;
  }

  if (status === WORKER_WORK_STATUS.WORKING || status === WORKER_WORK_STATUS.WAITING_TEAM) {
    return assignment?.scanned_at ?? assignment?.updated_at ?? assignment?.accepted_at ?? queue?.updated_at ?? presence.last_seen_at;
  }

  if (status === WORKER_WORK_STATUS.BREAK) {
    return queue?.updated_at ?? presence.last_seen_at;
  }

  if (status === WORKER_WORK_STATUS.OPEN_APP) {
    // ใช้เวลาเริ่ม presence รอบนี้ ไม่ใช้ queue updated_at ที่อาจเป็นของกะก่อน
    return presence.session_started_at ?? presence.last_seen_at;
  }

  return queue?.updated_at ?? presence.last_seen_at;
}

// Function เปรียบเทียบลำดับ worker บนบอร์ดตามสถานะและเวลา
function compareAdminWorkerStatusItems(
  left: AdminWorkerStatusItem,
  right: AdminWorkerStatusItem
): number {
  const statusOrderDiff =
    ADMIN_WORKER_STATUS_ORDER[left.status] - ADMIN_WORKER_STATUS_ORDER[right.status];

  if (statusOrderDiff !== 0) {
    return statusOrderDiff;
  }

  if (left.status === WORKER_WORK_STATUS.READY && right.status === WORKER_WORK_STATUS.READY) {
    const leftQueuePosition = left.queue_position ?? Number.POSITIVE_INFINITY;
    const rightQueuePosition = right.queue_position ?? Number.POSITIVE_INFINITY;

    if (leftQueuePosition !== rightQueuePosition) {
      return leftQueuePosition - rightQueuePosition;
    }
  }

  const timestampDiff =
    timestampToSortValue(left.status_entered_at) -
    timestampToSortValue(right.status_entered_at);

  if (timestampDiff !== 0) {
    return timestampDiff;
  }

  return String(left.worker_code ?? "").localeCompare(String(right.worker_code ?? ""));
}

// Function หาเวลากิจกรรมล่าสุดของ worker
function resolveLatestActivityAt(
  queue: WorkerQueueEntryDto | null,
  assignment: TicketJobAssignmentDto | null,
  presence: WorkerPresenceDto
): string | null {
  if (assignment) {
    return latestTimestamp([
      assignment.completed_at,
      assignment.scanned_at,
      assignment.accepted_at,
      assignment.updated_at,
      assignment.created_at,
      queue?.updated_at,
      presence.last_seen_at,
    ]);
  }

  if (queue?.status === WORKER_WORK_STATUS.READY) {
    return latestTimestamp([queue.ready_at, queue.updated_at, presence.last_seen_at]);
  }

  return latestTimestamp([queue?.updated_at, presence.last_seen_at]);
}

// Function จัดรูปแบบสถานะ worker หนึ่งคนสำหรับบอร์ด Admin
function formatAdminWorkerStatusItem(
  worker: MasterWorkerDto,
  schedule: WorkScheduleDto | null,
  queue: WorkerQueueEntryDto | null,
  assignment: TicketJobAssignmentDto | null,
  presence: WorkerPresenceDto,
  queueRank: number | null = null,
  socketConnected = isWorkerSocketConnected(worker.id),
  teamScanReadiness: Pick<VehicleWorkReadinessDto, "is_ready"> | null = null,
  ticketNumber: string | null = null,
  attendance: Pick<WorkerCheckinLog, "closedAt" | "closeReason" | "firstOnlineAt"> | null = null,
  settings: Pick<RuntimeSettings, "worker_accept_timeout_limit" | "worker_break_retry"> | null = null,
): AdminWorkerStatusItem {
  const status = resolveWorkerWorkStatus(queue, assignment, teamScanReadiness);
  const isOvertime =
    assignment !== null && (!schedule || !isTimeInWorkSchedule(schedule));
  // ใช้ resolver เดียวกับฝั่ง worker ให้ Admin เห็นสาเหตุเดียวกัน
  const { reasonCode } = resolveShiftActiveStatus({
    isWithinShiftTime: Boolean(schedule && isTimeInWorkSchedule(schedule)),
    closedAt: attendance?.closedAt,
    closeReason: attendance?.closeReason,
    firstOnlineAt: attendance?.firstOnlineAt,
    queueStatus: queue?.status,
    openAppReason: queue?.open_app_reason,
  });

  return {
    full_name: worker.full_name,
    worker_code: worker.labor_code,
    labor_color: worker.labor_color,
    shirt_number: worker.coat_no,
    image_url: worker.image_url,
    shift_name: schedule?.shift_name ?? null,
    latest_activity_at: resolveLatestActivityAt(queue, assignment, presence),
    status_entered_at: resolveStatusEnteredAt(status, queue, assignment, presence),
    queue_position: status === WORKER_WORK_STATUS.READY && queueRank !== null ? queueRank + 1 : null,
    socket_connected: socketConnected,
    status,
    is_overtime: isOvertime,
    assignment: assignment
      ? {
          ticket_number: ticketNumber,
          status: assignment.status,
          created_at: assignment.created_at,
          accepted_at: assignment.accepted_at,
          accept_deadline_at: assignment.accept_deadline_at,
          accept_deadline_unix_ms: toUnixMs(assignment.accept_deadline_at),
          scan_deadline_at: assignment.scan_deadline_at,
        }
      : null,
    // แสดง reason เฉพาะสถานะ open_app
    ...(reasonCode && settings && status === WORKER_WORK_STATUS.OPEN_APP
      ? {
          reason_code: reasonCode,
          // Admin dashboard เป็นภาษาไทยเสมอ
          reason_text: resolveShiftInactiveReasonText(reasonCode, "TH", {
            accept_timeout_limit: settings.worker_accept_timeout_limit,
            break_retry_minutes: settings.worker_break_retry,
          }),
        }
      : {}),
  };
}

// Function นับจำนวน worker แยกตามสถานะสำหรับบอร์ด Admin
function buildAdminWorkerStatusSummary(items: AdminWorkerStatusItem[]): {
  total: number;
  open_app: number;
  ready: number;
  assigned: number;
  waiting_team: number;
  working: number;
  break: number;
} {
  return items.reduce(
    (summary, item) => {
      summary.total += 1;
      if (item.status === WORKER_WORK_STATUS.OPEN_APP) {
        summary.open_app += 1;
      } else if (item.status === WORKER_WORK_STATUS.READY) {
        summary.ready += 1;
      } else if (item.status === WORKER_WORK_STATUS.ASSIGNED) {
        summary.assigned += 1;
      } else if (item.status === WORKER_WORK_STATUS.WAITING_TEAM) {
        summary.waiting_team += 1;
      } else if (item.status === WORKER_WORK_STATUS.WORKING) {
        summary.working += 1;
      } else if (item.status === WORKER_WORK_STATUS.BREAK) {
        summary.break += 1;
      }

      return summary;
    },
    {
      total: 0,
      open_app: 0,
      ready: 0,
      assigned: 0,
      waiting_team: 0,
      working: 0,
      break: 0,
    }
  );
}

// Function ดึงสถานะของ worker หนึ่งคนสำหรับบอร์ด Admin
async function getAdminWorkerStatus(idParam: unknown): Promise<AdminWorkerStatusItem> {
  const worker = await requireWorker(
    typeof idParam === "number" ? idParam : String(idParam)
  );

  const [currentSchedule, queueEntry, assignment, presence, queueRanks, settings] = await Promise.all([
    Promise.resolve(scheduleFromWorker(worker)),
    getWorkerQueueStatus(worker.id),
    assignmentRepository.findCurrentAssignmentByWorker(worker.id),
    getWorkerPresence(worker.id),
    getWorkerReadyQueueRanks([worker.id]),
    getRuntimeSettings(),
  ]);
  const [teamScanReadiness, ticketJob] = assignment
    ? await Promise.all([
        assignmentRepository.getTicketJobTeamScanReadiness(
          assignment.vehicle_job_id,
        ),
        ticketJobRepository.findTicketJobById(assignment.vehicle_job_id),
      ])
    : [null, null];
  const attendance = currentSchedule
    ? await workerCheckinLogRepository.findByWorkerAndShift({
        worker_id: worker.id,
        shift_instance_key: buildWorkScheduleShiftInstanceKey(currentSchedule),
      })
    : null;

  return formatAdminWorkerStatusItem(
    worker,
    currentSchedule,
    queueEntry,
    assignment,
    presence,
    queueRanks.get(worker.id) ?? null,
    isWorkerSocketConnected(worker.id),
    teamScanReadiness,
    ticketJob?.ticket_number ?? null,
    attendance,
    settings,
  );
}

// Function ดึงสถานะ worker ทั้งหมดสำหรับบอร์ด Admin (ไม่ส่ง page/limit = ดึงทั้งหมด)
export async function listAdminWorkerStatuses(query: Record<string, unknown> = {}): Promise<{
  summary: ReturnType<typeof buildAdminWorkerStatusSummary>;
  data: AdminWorkerStatusItem[];
  pagination?: PaginationMeta;
}> {
  const { page, limit } = parseWithSchema(optionalPaginationQuerySchema, query);
  const workers = await adminWorkersRepository.listUsers({ offset: 0, limit: Number.MAX_SAFE_INTEGER });
  const workerIds = workers.map((worker) => worker.id);
  const [queueStatuses, queueRanks, presences, assignmentMap, settings] = await Promise.all([
    getWorkerQueueStatuses(workerIds),
    getWorkerReadyQueueRanks(workerIds),
    getWorkerPresences(workerIds),
    assignmentRepository.findCurrentAssignmentsByWorkers(workerIds),
    getRuntimeSettings(),
  ]);
  const ticketJobIds = Array.from(
    new Set(
      Array.from(assignmentMap.values()).map((assignment) => assignment.vehicle_job_id),
    ),
  );
  const teamScanReadinessMap = await assignmentRepository.getTicketJobTeamScanReadinessBatch(
    ticketJobIds,
  );
  const ticketJobTicketNumberMap = new Map(
    Array.from(teamScanReadinessMap.entries()).map(([ticketJobId, readiness]) => [
      ticketJobId,
      readiness.ticket_number,
    ]),
  );
  // ดึง checkin log ของกะปัจจุบันทุกคนในครั้งเดียว เพื่อคำนวณ reason
  const workersWithSchedule = workers
    .map((worker) => ({ worker, schedule: scheduleFromWorker(worker) }))
    .filter(
      (entry): entry is { worker: MasterWorkerDto; schedule: WorkScheduleDto } =>
        entry.schedule !== null,
    );
  const attendanceMap = await workerCheckinLogRepository.findManyByWorkerAndShiftKeys(
    workersWithSchedule.map(({ worker, schedule }) => ({
      worker_id: worker.id,
      shift_instance_key: buildWorkScheduleShiftInstanceKey(schedule),
    })),
  );

  const data = workers
    .map((worker) => {
      const schedule = scheduleFromWorker(worker);
      const presence =
        presences.get(worker.id) ?? {
          is_online: false,
          last_seen_at: null,
          stale_after_seconds: settings.worker_presence_stale_seconds,
          session_started_at: null,
        };

      const queue = queueStatuses.get(worker.id) ?? null;
      const assignment = assignmentMap.get(worker.id) ?? null;
      const socketConnected = isWorkerSocketConnected(worker.id);
      const attendance = attendanceMap.get(worker.id) ?? null;

      return {
        worker,
        assignment,
        presence,
        queue,
        schedule,
        item: formatAdminWorkerStatusItem(
          worker,
          schedule,
          queue,
          assignment,
          presence,
          queueRanks.get(worker.id) ?? null,
          socketConnected,
          assignment
            ? teamScanReadinessMap.get(assignment.vehicle_job_id) ?? null
            : null,
          assignment
            ? ticketJobTicketNumberMap.get(assignment.vehicle_job_id) ?? null
            : null,
          attendance,
          settings,
        ),
      };
    })
    .filter(({ worker, assignment, presence, queue, schedule, item }) => {
      // worker ที่มี reason_code ต้องแสดงเสมอแม้ offline เพื่อให้ Admin force เข้าคิวได้
      const hasVisibleWorkerFlow =
        presence.is_online ||
        assignment !== null ||
        item.reason_code !== undefined ||
        (queue !== null && queue.status !== WORKER_WORK_STATUS.OPEN_APP);

      const isOvertime = assignment !== null;

      return (
        worker.status === MASTER_WORKER_STATUS.ACTIVE &&
        hasVisibleWorkerFlow &&
        schedule !== null &&
        (isTimeInWorkSchedule(schedule) || isOvertime)
      );
    })
    .map(({ item }) => item)
    .sort(compareAdminWorkerStatusItems);

  const summary = buildAdminWorkerStatusSummary(data);

  if (page === undefined && limit === undefined) {
    return { summary, data };
  }

  const effectivePage = page ?? 1;
  const effectiveLimit = limit ?? DEFAULT_PAGE_LIMIT;
  const offset = (effectivePage - 1) * effectiveLimit;

  return {
    summary,
    data: data.slice(offset, offset + effectiveLimit),
    pagination: buildPaginationMeta(effectivePage, effectiveLimit, data.length),
  };
}

// Function ให้ Admin บังคับเปลี่ยนสถานะคิวของ worker
export async function forceAdminWorkerStatus(
  idParam: unknown,
  body: unknown,
  auth?: AccessTokenPayload
): Promise<{
  message: string;
  full_name: string | null;
  worker_code: string;
  status: AdminWorkerBoardStatus;
}> {
  const input = parseWithSchema(adminForceWorkerStatusBodySchema, body);
  const actorId = requireActorId(auth);
  const settings = await getRuntimeSettings();
  const worker = await requireWorker(
    typeof idParam === "number" ? idParam : String(idParam)
  );

  if (worker.status !== MASTER_WORKER_STATUS.ACTIVE) {
    throw new ApiError(403, "WORKER_NOT_ACTIVE", "Worker account is not active.");
  }

  // force เป็น READY/BREAK ต้อง online (OPEN_APP ทำได้แม้ offline)
  if (input.status !== WORKER_WORK_STATUS.OPEN_APP && !isWorkerSocketConnected(worker.id)) {
    throw new ApiError(
      409,
      "WORKER_NOT_ONLINE",
      "Worker WebSocket is not connected. Admin can force status to READY or BREAK only for online workers."
    );
  }

  const [queueEntry, currentAssignment] = await Promise.all([
    getWorkerQueueStatus(worker.id),
    assignmentRepository.findCurrentAssignmentByWorker(worker.id),
  ]);
  const currentSchedule = scheduleFromWorker(worker);

  // ห้าม force worker ที่อยู่นอกเวลากะ
  if (!currentSchedule || !isTimeInWorkSchedule(currentSchedule)) {
    throw new ApiError(
      403,
      "WORKER_OUTSIDE_WORK_SHIFT",
      "Cannot force worker status while the worker is outside their work shift. Fix the worker's shift time first.",
      currentSchedule ? buildShiftWaitInfo(currentSchedule) : undefined
    );
  }

  if (
    currentAssignment &&
    !(input.status === WORKER_WORK_STATUS.READY && currentAssignment.status === ASSIGNMENT_STATUS.DELIVERED)
  ) {
    throw new ApiError(
      409,
      "WORKER_HAS_ACTIVE_ASSIGNMENT",
      "Worker has an active assignment. Cancel or finish the assignment before forcing worker status."
    );
  }

  const shiftInstanceKey = buildWorkScheduleShiftInstanceKey(currentSchedule);
  const isEnteringBreak =
    input.status === WORKER_WORK_STATUS.BREAK &&
    queueEntry?.status !== WORKER_WORK_STATUS.BREAK;

  // เช็ค break limit ก่อนเขียน audit log
  if (isEnteringBreak) {
    const currentBreakCount = await getWorkerBreakCount(worker.id, shiftInstanceKey);

    if (currentBreakCount >= settings.worker_break_limit) {
      throw new ApiError(
        409,
        "BREAK_LIMIT_REACHED",
        "Worker break limit reached for this shift."
      );
    }
  }

  // เขียน audit log ก่อนแก้ Redis (DB ล้มจะไม่เปลี่ยนสถานะ)
  await adminActionLogRepository.create({
    vehicle_job_id: currentAssignment?.vehicle_job_id ?? null,
    action_type: ADMIN_ACTION_TYPE.WORKER_STATUS_FORCED,
    reason_code: input.reason_code ?? null,
    reason_text: input.reason_text ?? null,
    actor_account_id: actorId,
    metadata: {
      worker_id: worker.id,
      worker_code: worker.labor_code,
      status: input.status,
      previous_status: queueEntry?.status ?? null,
    },
  });

  // ดึงกลับเข้างานต้องเปิดกะที่ถูกปิดกลับมาด้วย
  if (input.status !== WORKER_WORK_STATUS.OPEN_APP) {
    await reopenWorkerAttendanceShift(worker, currentSchedule, shiftInstanceKey);
  }

  if (queueEntry?.status === WORKER_WORK_STATUS.BREAK && input.status !== WORKER_WORK_STATUS.BREAK) {
    await removeWorkerBreakReturn(worker.id, currentSchedule.id);
    await closeWorkerBreakLog(worker.id, shiftInstanceKey, "admin_forced");
  }

  if (input.status === WORKER_WORK_STATUS.READY) {
    await enqueueWorker(worker.id);

    // dispatch แบบ best-effort
    try {
      await dispatchReadyWorkers();
    } catch (error) {
      logger.error("Worker was forced ready but dispatch failed.", {
        workerId: worker.id,
        error,
      });
    }
  }

  if (input.status === WORKER_WORK_STATUS.OPEN_APP) {
    await markWorkerOpenApp(worker.id, WORKER_OPEN_APP_REASON.ADMIN_FORCED_STATUS);
  }

  if (input.status === WORKER_WORK_STATUS.BREAK) {
    const breakDurationMs = settings.worker_break_duration_minutes * 60 * 1000;
    const breakUntil = buildDeadline(breakDurationMs);

    if (isEnteringBreak) {
      await incrementWorkerBreakCount(worker.id, shiftInstanceKey);
      // บันทึก break log เหมือนตอน Worker กดพักเอง ไม่งั้นรายงานเวลาพักไม่เห็นการพักที่ Admin สั่ง
      await startWorkerBreakLog(worker.id, shiftInstanceKey, breakUntil);
    }

    await markWorkerBreak(worker.id, breakUntil);
    await scheduleWorkerBreakReturn(
      worker.id,
      currentSchedule.id,
      breakDurationMs
    );
  }

  // ตั้ง job จบกะใหม่เมื่อดึงกลับเข้างาน
  if (input.status !== WORKER_WORK_STATUS.OPEN_APP) {
    await scheduleWorkerShiftEndIfNeeded(worker.id, currentSchedule);
  }

  const [latest, latestQueue, latestAssignment] = await Promise.all([
    getAdminWorkerStatus(worker.id),
    getWorkerQueueStatus(worker.id),
    assignmentRepository.findCurrentAssignmentByWorker(worker.id),
  ]);
  const latestAssignmentPayload = await buildWorkerAssignmentSocketPayload(
    latestAssignment
  );
  // ต้องใช้ความพร้อมของทีมด้วย ไม่งั้นสถานะจะเป็น WORKING ทั้งที่ทีมยังมาไม่ครบ
  const latestTeamScan = latestAssignment
    ? await assignmentRepository.getTicketJobTeamScanReadiness(
        latestAssignment.vehicle_job_id
      )
    : null;
  sendWorkerSocketEvent(worker.id, "WORKER_STATUS_CHANGED", {
    queue: buildWorkerQueueSocketPayload(
      latestQueue,
      latest.worker_code,
      latestAssignment,
      latestTeamScan
    ),
    current_assignment: latestAssignmentPayload,
    reason: "admin_force_status",
  });
  // ส่ง event พร้อม FCM ให้ worker รู้ว่า Admin เปลี่ยนสถานะให้
  sendWorkerSocketEvent(
    worker.id,
    "WORKER_STATUS_FORCED_BY_ADMIN",
    {
      status: input.status,
      reason_text: input.reason_text ?? null,
    },
    { push: true }
  );
  publishAdminWorkerStatusChanged({
    title: "Worker status forced",
    message: `Worker ${latest.full_name ?? latest.worker_code} status was forced by admin.`,
    workerCode: latest.worker_code,
    queue: latestQueue,
    assignment: latestAssignment,
    team_scan_readiness: latestTeamScan,
    reason: "admin_force_status",
    extraPayload: {
      current_assignment: latestAssignmentPayload,
    },
  });

  return {
    message: "Worker status forced successfully.",
    full_name: latest.full_name,
    worker_code: latest.worker_code,
    status: latest.status,
  };
}
