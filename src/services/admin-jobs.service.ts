// Import Library
import { Prisma } from "@prisma/client";
// Import Config
import { withTransaction } from "../db/prisma";
// Import Queues
import { getWorkerQueueStatus, markWorkerAssigned, markWorkerOpenApp, removeAssignmentTimeout, removeScanTimeout, removeScanWarning, scheduleAssignmentTimeout, scheduleScanTimeout, scheduleScanWarning } from "../queues/worker-queue";
import { autoReleaseTicketJobWorkersIfShiftEnded, dispatchReadyWorkers, requeueWorkersAtFrontRespectingShift, returnCompletedWorkersToQueue } from "../queues/worker-dispatch";
// Import Utils
import { sendWorkerSocketEvent } from "../websockets/worker.socket";
// Import Repositories
import * as adminActionLogRepository from "../repositories/shared/admin-action-log.repository";
import * as adminJobsRepository from "../repositories/admin-jobs.repository";
import * as assignmentRepository from "../repositories/shared/ticket-job-assignment.repository";
import * as driverSessionRepository from "../repositories/shared/driver-session.repository";
import * as boothJobRepository from "../repositories/shared/booth-job.repository";
import * as marketJobRepository from "../repositories/shared/market-job.repository";
import * as masterDataRepository from "../repositories/shared/master-data.repository";
import * as profileRepository from "../repositories/shared/profile.repository";
import * as ticketWorkerRepository from "../repositories/shared/ticket-worker.repository";
import * as ticketJobRepository from "../repositories/shared/ticket-job.repository";
import * as workScheduleRepository from "../repositories/shared/work-schedule.repository";
// Import Services
import { publishAdminWorkerStatusChanged, publishNotification } from "./notifications.service";
import { publishRealtimeEvent } from "./shared/realtime-notification.service";
import { getRuntimeSettings } from "./shared/runtime-settings.service";
import * as ticketJobLifecycleService from "./shared/ticket-job-lifecycle.service";
import * as ticketCompletionService from "./shared/ticket-completion.service";
import { notifyVendorBoothCancelled, notifyVendorBoothDispatchResumed, notifyVendorBoothWait } from "./shared/vendor-line-notification.service";
import { notifyTicketJobTeamScanReadiness } from "./worker.service";
// Import Utils
import { buildVehicleOperationSummary, formatVehicleOperationItem } from "../utils/admin-job-operations.formatter";
import { isTimeInWorkSchedule } from "../utils/shift";
import { logger } from "../utils/logger";
// Import Types
import type { AdminTicketJobFinancialResponse, AdminTicketJobFinancialRecord, AdminAssignmentResponse, AdminAssignWorkersResponse, AdminCancelAssignmentResponse, AdminCancelTicketWorkerFromBoothResponse, AdminCancelTicketWorkerResponse, AdminCancelTicketJobAndRequeueResponse, AdminExtendScanDeadlineResponse, AdminHistoryCancellationResponse, AdminHistoryRejectionResponse, AdminHistoryBoothResponse, AdminHistoryProductResponse, AdminHistoryTimelineItemResponse, AdminHistoryWorkerResponse, AdminTicketJobAssignmentCancelResponse, HistoryStatusValue, HistoryFlagValue, DailyStallFeeItemResponse, DailyStallFeeListResponse, DailyStallFeeRecord, DailyWorkerIncomeItemResponse, DailyWorkerIncomePaymentStatus, DailyWorkerIncomeRecord, MonthlyStallFeeGroupRow, MonthlyStallFeeItemResponse, MonthlyStallFeeListResponse, AdminMarketJobActionResponse, AdminOverrideCountResponse, AdminReleaseWorkersResponse, AdminScanDeadlineAssignmentResponse, AdminStallJobActionResponse, AdminTicketJobHistoryItemResponse, AdminTicketJobHistoryRecord, AdminTicketJobOperationListResponse, AdminVehicleWaitResponse } from "../types/admin-jobs.type";
import { HISTORY_FLAG_VALUES } from "../types/admin-jobs.type";
import { MASTER_WORKER_STATUS } from "../types/admin-workers.type";
import type { AccessTokenPayload } from "../types/auth.type";
import type { CompletedTicketJobResult, BoothJobDto, MarketJobDto, TicketJobAssignmentDto, TicketJobDto } from "../types/worker.type";
import type { DbConnection } from "../types/shared/common.type";
// Import Validation
import { parseWithSchema } from "../validation/parser";
import { adminAssignWorkersBodySchema, adminCancelAssignmentBodySchema, adminCancelBodySchema, adminDailyStallFeeQuerySchema, adminDailyWorkerIncomeQuerySchema, adminExtendScanDeadlineBodySchema, adminMonthlyStallFeeQuerySchema, adminOverrideCountBodySchema, adminReleaseWorkersBodySchema, adminTicketJobAssignmentCancelBodySchema, adminTicketJobListQuerySchema, adminTicketJobOperationsQuerySchema, adminVehicleWaitBodySchema } from "../validation/schemas";
// Import Utils
import { requireActorId } from "../utils/actor";
import ApiError from "../utils/api-error";
// Import Config
import { ACTIVE_ASSIGNMENT_STATUSES, ASSIGNMENT_STATUS, DAILY_WORKER_INCOME_PAYMENT_STATUS, SUBMITTED_TICKET_STATUSES, TERMINAL_JOB_STATUSES, TERMINAL_TICKET_STATUSES, TICKET_STATUS, TICKET_SUBMITTER_ROLE, TICKET_WORKER_STATUS, VEHICLE_JOB_STATUS } from "../constants/status";
import { DEFAULT_PAGE_LIMIT } from "../constants/pagination";
import { ADMIN_ACTION_TYPE } from "../types/shared/admin-action-log.type";
import type { AdminActionLogDto } from "../types/shared/admin-action-log.type";
import { WORKER_ASSIGNMENT_EVENT_TYPE } from "../types/shared/worker-assignment-event.type";
import { buildBangkokDateSpanRange, buildDeadline, formatBangkokDate, getDelayUntil, toUnixMs } from "../utils/time";
import { buildWorkerAssignedPayload } from "../utils/worker-payload";
import { WORKER_WORK_STATUS } from "../types/shared/worker-status.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function อ่านค่า reference ใน service flow
function parseReference(value: unknown, code: string, message: string): string {
  const reference = String(value ?? "").trim();

  if (!reference) {
    throw new ApiError(400, code, message);
  }

  return reference;
}

// Function ระบุ Timeline type จาก WorkerAssignmentEvent ใน service flow
function mapAssignmentEventToTimelineType(eventType: string): string {
  switch (eventType) {
    case WORKER_ASSIGNMENT_EVENT_TYPE.ASSIGNED:
      return "WORKER_ASSIGNED";
    case WORKER_ASSIGNMENT_EVENT_TYPE.ACCEPTED:
      return "WORKER_ACCEPTED";
    case WORKER_ASSIGNMENT_EVENT_TYPE.SCANNED:
      return "WORKER_SCANNED";
    case WORKER_ASSIGNMENT_EVENT_TYPE.ACCEPT_TIMEOUT:
      return "WORKER_ACCEPT_TIMEOUT";
    case WORKER_ASSIGNMENT_EVENT_TYPE.SCAN_TIMEOUT:
      return "WORKER_SCAN_TIMEOUT";
    case WORKER_ASSIGNMENT_EVENT_TYPE.COMPLETED:
      return "WORKER_COMPLETED";
    case WORKER_ASSIGNMENT_EVENT_TYPE.ADMIN_CANCELLED:
      return "ADMIN_ACTION";
    default:
      return eventType;
  }
}

// Function บรรยาย Admin action หนึ่งรายการสำหรับ Timeline ใน service flow
function describeAdminAction(log: AdminActionLogDto): string {
  const actor = log.actor_username ?? "Admin";

  switch (log.action_type) {
    case ADMIN_ACTION_TYPE.OVERRIDE_COUNT:
      return `${actor} overrode booth counts.`;
    case ADMIN_ACTION_TYPE.VEHICLE_WAIT:
      return log.metadata?.dispatch === true
        ? `${actor} dispatched the vehicle job again.`
        : `${actor} set the vehicle job back to wait.`;
    case ADMIN_ACTION_TYPE.WORKERS_RELEASED:
      return `${actor} released workers back to the queue.`;
    case ADMIN_ACTION_TYPE.ASSIGNMENT_CANCELLED:
      return `${actor} cancelled a worker assignment.`;
    case ADMIN_ACTION_TYPE.SCAN_DEADLINE_EXTENDED:
      return `${actor} extended the scan deadline.`;
    case ADMIN_ACTION_TYPE.MANUAL_ASSIGNMENT:
      return `${actor} manually assigned worker(s).`;
    default:
      return `${actor} performed ${log.action_type}.`;
  }
}

// Function ค้นหา AdminActionLog ของการ Cancel Assignment นี้เจาะจง ถ้าไม่มี Log ระดับ assignment
// (ถูกยกเลิกทางอ้อมจากการยกเลิกทั้ง TicketNumber) fallback ไป Log VEHICLE_JOB_CANCELLED ล่าสุดแทน
function findAssignmentCancelLog(
  adminActionLogs: AdminActionLogDto[],
  assignmentId: number,
): AdminActionLogDto | null {
  const assignmentLog = adminActionLogs.find(
    (log) =>
      log.action_type === ADMIN_ACTION_TYPE.ASSIGNMENT_CANCELLED &&
      (log.metadata as { assignment_id?: number } | null)?.assignment_id ===
        assignmentId,
  );

  if (assignmentLog) {
    return assignmentLog;
  }

  const vehicleCancelLogs = adminActionLogs
    .filter((log) => log.action_type === ADMIN_ACTION_TYPE.VEHICLE_JOB_CANCELLED)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  return vehicleCancelLogs[0] ?? null;
}

// Function ค้นหา AdminActionLog ของการยกเลิกทั้งคัน (TicketJob) — เป็นระดับบนสุด ไม่มี fallback
function findVehicleCancelLog(
  adminActionLogs: AdminActionLogDto[],
): AdminActionLogDto | null {
  const vehicleCancelLogs = adminActionLogs
    .filter((log) => log.action_type === ADMIN_ACTION_TYPE.VEHICLE_JOB_CANCELLED)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  return vehicleCancelLogs[0] ?? null;
}

// Function ค้นหา AdminActionLog ของการยกเลิกตลาด (MarketJob) นี้เจาะจง ถ้าไม่มี Log ระดับตลาดเอง
// (ถูกยกเลิกทางอ้อมจากการยกเลิกทั้งคัน) fallback ไป Log VEHICLE_JOB_CANCELLED แทน
function findMarketCancelLog(
  adminActionLogs: AdminActionLogDto[],
  marketJobId: number,
): AdminActionLogDto | null {
  const marketLogs = adminActionLogs
    .filter(
      (log) =>
        log.action_type === ADMIN_ACTION_TYPE.MARKET_JOB_CANCELLED &&
        log.market_job_id === marketJobId,
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  if (marketLogs[0]) {
    return marketLogs[0];
  }

  return findVehicleCancelLog(adminActionLogs);
}

// Function ค้นหา AdminActionLog ของการยกเลิกแผง (BoothJob/Booth) นี้เจาะจง ถ้าไม่มี Log ระดับแผงเอง
// fallback ไล่ขึ้นไปที่ระดับตลาดแล้วรถตามลำดับ (ดู findMarketCancelLog)
function findBoothCancelLog(
  adminActionLogs: AdminActionLogDto[],
  boothJobId: number,
  marketJobId: number,
): AdminActionLogDto | null {
  const boothLogs = adminActionLogs
    .filter(
      (log) =>
        log.action_type === ADMIN_ACTION_TYPE.STALL_JOB_CANCELLED &&
        log.gate_ticket_id === boothJobId,
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  if (boothLogs[0]) {
    return boothLogs[0];
  }

  return findMarketCancelLog(adminActionLogs, marketJobId);
}

// Function ประกอบ AdminHistoryCancellationResponse จาก Log ที่หาเจอ ใช้ร่วมกันทุกระดับ (TicketJob/
// MarketJob/BoothJob) ถ้า status เป็น CANCELLED แต่หา Log ไม่เจอ sub-field จะเป็น null แทนการเดา
function formatCancellationResponse(
  isCancelled: boolean,
  cancelLog: AdminActionLogDto | null,
): AdminHistoryCancellationResponse | null {
  if (!isCancelled) {
    return null;
  }

  return {
    cancelled_at: cancelLog?.created_at ?? null,
    reason_code: cancelLog?.reason_code ?? null,
    reason_text: cancelLog?.reason_text ?? null,
    cancelled_by_type: cancelLog?.actor_role ?? null,
    cancelled_by_name: cancelLog?.actor_full_name ?? null,
  };
}

// Function ค้นหา AdminActionLog ของการ Release Workers ที่ครอบคลุม worker คนนี้ ถ้ามีหลาย Log
// (ปล่อยคนละรอบ) เลือก Log ที่ created_at ใกล้ releasedAt ที่สุด
function findWorkersReleasedLog(
  adminActionLogs: AdminActionLogDto[],
  workerId: number,
  releasedAt: Date,
): AdminActionLogDto | null {
  const candidates = adminActionLogs.filter((log) => {
    if (log.action_type !== ADMIN_ACTION_TYPE.WORKERS_RELEASED) {
      return false;
    }

    const workerIds = (
      log.metadata as { worker_ids?: number[] } | null
    )?.worker_ids;

    return (
      Array.isArray(workerIds) &&
      workerIds.includes(workerId)
    );
  });

  if (candidates.length === 0) {
    return null;
  }

  return candidates.reduce((closest, log) => {
    const closestDiff = Math.abs(
      new Date(closest.created_at).getTime() - releasedAt.getTime(),
    );
    const logDiff = Math.abs(
      new Date(log.created_at).getTime() - releasedAt.getTime(),
    );

    return logDiff < closestDiff ? log : closest;
  });
}

// Function เลือก accepted assignment ล่าสุดต่อ worker หนึ่งคน จาก assignments ทั้งหมดของ TicketJob นี้
// worker ที่ไม่เคยกด Accept (acceptedAt เป็น null) จะไม่ถูกเลือก
function selectLatestAcceptedAssignmentPerWorker(
  assignments: AdminTicketJobHistoryRecord["assignments"],
): AdminTicketJobHistoryRecord["assignments"] {
  const latestByWorkerId = new Map<number, AdminTicketJobHistoryRecord["assignments"][number]>();

  for (const assignment of assignments) {
    if (!assignment.acceptedAt) {
      continue;
    }

    const existing = latestByWorkerId.get(assignment.workerId);

    if (
      !existing ||
      !existing.acceptedAt ||
      assignment.acceptedAt.getTime() > existing.acceptedAt.getTime() ||
      (assignment.acceptedAt.getTime() === existing.acceptedAt.getTime() &&
        assignment.id > existing.id)
    ) {
      latestByWorkerId.set(assignment.workerId, assignment);
    }
  }

  return Array.from(latestByWorkerId.values());
}

// Function สร้างรายการ Worker ของ TicketJob สำหรับ Work History เฉพาะคนที่กดรับงานจริงและไม่ซ้ำต่อคน
// (ดู selectLatestAcceptedAssignmentPerWorker) ไม่กระทบ Timeline ที่ยังคง event ครบทุก assignment
function formatAdminHistoryWorkers(
  record: AdminTicketJobHistoryRecord,
  adminActionLogs: AdminActionLogDto[],
): AdminHistoryWorkerResponse[] {
  // submitted_at ผูกกับ assignmentId ที่ stamp ไว้ตอน Submit เท่านั้น ไม่รวม submission ที่ไม่มี assignmentId
  const submittedAtByAssignmentId = new Map<number, string>();

  for (const market of record.marketJobs) {
    for (const ticket of market.tickets) {
      for (const submission of ticket.completionSubmissions) {
        if (submission.assignmentId === null) {
          continue;
        }

        const createdAtIso = submission.createdAt.toISOString();
        const existing = submittedAtByAssignmentId.get(submission.assignmentId);

        if (!existing || createdAtIso > existing) {
          submittedAtByAssignmentId.set(submission.assignmentId, createdAtIso);
        }
      }
    }
  }

  const selectedAssignments = selectLatestAcceptedAssignmentPerWorker(record.assignments);

  return selectedAssignments.map((assignment) => {
    const adminCancelledEvent = assignment.events.find(
      (event) => event.eventType === WORKER_ASSIGNMENT_EVENT_TYPE.ADMIN_CANCELLED,
    );

    return {
      worker_id: assignment.workerId,
      assignment_id: assignment.id,
      worker_code: assignment.worker.laborCode,
      full_name: assignment.worker.fullName ?? assignment.worker.laborCode,
      labor_color: assignment.worker.laborColor ?? null,
      shirt_number: assignment.worker.coatNo ?? null,
      accepted_at: assignment.acceptedAt?.toISOString() ?? null,
      scanned_at: assignment.scannedAt?.toISOString() ?? null,
      // Worker เริ่มงานตั้งแต่ Scan เข้างานจริง ไม่ใช่ตอนกด Accept ใช้ workStartedAt ระดับ TicketJob
      // เป็นหลัก fallback เป็น scannedAt เฉพาะข้อมูลเก่าที่ไม่มี workStartedAt
      started_at: assignment.scannedAt
        ? (record.workStartedAt?.toISOString() ?? assignment.scannedAt.toISOString())
        : null,
      submitted_at: submittedAtByAssignmentId.get(assignment.id) ?? null,
      released_at: assignment.releasedAt?.toISOString() ?? null,
      final_status: assignment.status,
      cancellation:
        assignment.status === ASSIGNMENT_STATUS.CANCELLED
          ? (() => {
            const cancelLog = findAssignmentCancelLog(adminActionLogs, assignment.id);

            return {
              // ห้าม fallback ไปใช้ assignment.updatedAt ถ้าไม่มี ADMIN_CANCELLED event จริงให้เป็น null
              cancelled_at: adminCancelledEvent?.occurredAt.toISOString() ?? null,
              reason_code: cancelLog?.reason_code ?? null,
              reason_text: cancelLog?.reason_text ?? null,
              cancelled_by_type: cancelLog?.actor_role ?? null,
              cancelled_by_name: cancelLog?.actor_full_name ?? null,
            };
          })()
          : null,
    };
  });
}

// Function สร้าง Timeline ของ TicketJob สำหรับ Work History ใน service flow โดยรวมเหตุการณ์จาก
// WorkerAssignmentEvent, TicketCompletionSubmission และ admin_action_logs แล้วเรียงตามเวลา
function formatAdminHistoryTimeline(
  record: AdminTicketJobHistoryRecord,
  adminActionLogs: AdminActionLogDto[],
  jobTimestamps: { ticket_created_at: string | null; completed_at: string | null },
): AdminHistoryTimelineItemResponse[] {
  const items: AdminHistoryTimelineItemResponse[] = [];

  // Gate Arrival ใช้ ticket_created_at ไม่ใช่ TicketJob.createdAt ถ้าไม่มี MarketJob เลยก็ไม่ต้องเดา
  if (jobTimestamps.ticket_created_at) {
    items.push({
      type: "GATE_ARRIVAL",
      occurred_at: jobTimestamps.ticket_created_at,
      actor_type: "system",
      actor_name: null,
      description: `Vehicle ${record.ticketNumber} arrived at Gate.`,
    });
  }

  for (const assignment of record.assignments) {
    for (const event of assignment.events) {
      const isAdminCancelled = event.eventType === WORKER_ASSIGNMENT_EVENT_TYPE.ADMIN_CANCELLED;
      const cancelLog = isAdminCancelled
        ? findAssignmentCancelLog(adminActionLogs, assignment.id)
        : null;

      items.push({
        type: mapAssignmentEventToTimelineType(event.eventType),
        occurred_at: event.occurredAt.toISOString(),
        actor_type: isAdminCancelled ? "admin" : "worker",
        // Cancel Actor ต้องเป็นแอดมินที่กด Cancel (จาก AdminActionLog) ไม่ใช่ชื่อ Worker ที่ถูก Cancel
        actor_name: isAdminCancelled
          ? cancelLog?.actor_full_name ?? null
          : assignment.worker.fullName,
        description: `${assignment.worker.laborCode}: ${event.eventType.toLowerCase()}.`,
      });
    }

    if (assignment.releasedAt) {
      const releaseLog = findWorkersReleasedLog(
        adminActionLogs,
        assignment.workerId,
        assignment.releasedAt,
      );

      items.push({
        type: "WORKER_RELEASED",
        occurred_at: assignment.releasedAt.toISOString(),
        actor_type: "admin",
        // Release Actor ต้องเป็นแอดมินที่กดปล่อย (จาก AdminActionLog) ไม่ใช่ชื่อ Worker ที่ถูกปล่อย
        actor_name: releaseLog?.actor_full_name ?? null,
        description: `${assignment.worker.laborCode} released back to queue.`,
      });
    }
  }

  for (const market of record.marketJobs) {
    for (const ticket of market.tickets) {
      for (const submission of ticket.completionSubmissions) {
        const isAdminSubmitted = submission.submittedByRole === TICKET_SUBMITTER_ROLE.ADMIN;
        const submitterName = resolveSubmitterName(submission);
        const submitterCode = resolveSubmitterCode(submission);

        items.push({
          type: "COUNT_SUBMITTED",
          occurred_at: submission.createdAt.toISOString(),
          actor_type: isAdminSubmitted ? "admin" : "worker",
          actor_name: submitterName,
          description: isAdminSubmitted
            ? `${submitterCode} submitted counts for booth ${ticket.boothCode} on behalf of the worker.`
            : `${submitterCode} submitted counts for booth ${ticket.boothCode}.`,
        });

        if (submission.rejectedAt) {
          items.push({
            type: "TICKET_REJECTED",
            occurred_at: submission.rejectedAt.toISOString(),
            actor_type: "system",
            actor_name: null,
            description: `Vendor rejected booth ${ticket.boothCode}.`,
          });
        }

        if (submission.confirmedAt) {
          items.push({
            type: "TICKET_CONFIRMED",
            occurred_at: submission.confirmedAt.toISOString(),
            actor_type: "system",
            actor_name: null,
            description: `Vendor confirmed booth ${ticket.boothCode}.`,
          });
        }
      }
    }
  }

  for (const log of adminActionLogs) {
    items.push({
      type: "ADMIN_ACTION",
      occurred_at: log.created_at,
      actor_type: "admin",
      actor_name: log.actor_full_name,
      description: describeAdminAction(log),
    });
  }

  if (record.status === VEHICLE_JOB_STATUS.COMPLETED && jobTimestamps.completed_at) {
    items.push({
      type: "JOB_COMPLETED",
      occurred_at: jobTimestamps.completed_at,
      actor_type: "system",
      actor_name: null,
      description: `Vehicle job ${record.ticketNumber} completed.`,
    });
  }

  return items.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
}

// Function derive job-level timestamp/duration ของ TicketJob สำหรับ Work History
// หา timestamp ที่ต้องการไม่ได้ก็คืน null แทนการเดา
function deriveAdminHistoryJobTimestamps(record: AdminTicketJobHistoryRecord): {
  ticket_created_at: string | null;
  work_started_at: string | null;
  submitted_complete_at: string | null;
  completed_at: string | null;
  duration_seconds: number | null;
} {
  // ticket_created_at = TicketCreatedAt ที่เร็วที่สุดของ MarketJobs ภายใน TicketJob นี้ (ห้ามใช้ assignments.scannedAt)
  const ticketCreatedTimestamps = record.marketJobs.map((market) => market.ticketCreatedAt);
  const ticketCreatedAt =
    ticketCreatedTimestamps.length > 0
      ? new Date(Math.min(...ticketCreatedTimestamps.map((value) => value.getTime())))
      : null;
  const workStartedAt = record.workStartedAt;

  const allTickets = record.marketJobs.flatMap((market) => market.tickets);
  // submitted_complete_at ไม่ต้องรอ Ticket ที่ CANCELLED แล้ว
  const requiredTickets = allTickets.filter(
    (ticket) => ticket.status !== TICKET_STATUS.CANCELLED,
  );
  const latestSubmissionPerRequiredTicket = requiredTickets.map((ticket) =>
    ticket.completionSubmissions.length > 0
      ? ticket.completionSubmissions[ticket.completionSubmissions.length - 1]
      : null,
  );
  const everyRequiredTicketSubmitted =
    requiredTickets.length > 0 &&
    latestSubmissionPerRequiredTicket.every((value) => value !== null);
  const submittedCompleteAt = everyRequiredTicketSubmitted
    ? new Date(
      Math.max(
        ...latestSubmissionPerRequiredTicket.map((submission) => submission!.createdAt.getTime()),
      ),
    )
    : null;

  // completed_at ใช้ TicketJob.completedAt ที่ persist ไว้จริง ห้าม derive จาก MarketJob.completedAt
  const completedAt = record.completedAt;

  // duration_seconds = completedAt - workStartedAt (เวลาทำงานจริงหลังทีม scan ครบ)
  const durationSeconds =
    completedAt && workStartedAt
      ? Math.round((completedAt.getTime() - workStartedAt.getTime()) / 1000)
      : null;

  return {
    ticket_created_at: ticketCreatedAt?.toISOString() ?? null,
    work_started_at: workStartedAt?.toISOString() ?? null,
    submitted_complete_at: submittedCompleteAt?.toISOString() ?? null,
    completed_at: completedAt?.toISOString() ?? null,
    duration_seconds: durationSeconds,
  };
}

// Type ข้อมูล MasterOwnerStall ที่ Batch-fetch มาแล้ว ใช้ประกอบ correction_owner และ resolve ผู้กด Reject ผ่าน LINE
type HistoryOwnerStallInfo = {
  full_name: string | null;
  card_id: string;
  line_user_id: string | null;
};

// Function ประกอบ key สำหรับ owner map ตาม marketCode + boothCode
function buildOwnerStallKey(marketCode: string, boothCode: string): string {
  return `${marketCode}::${boothCode}`;
}

// Function ประกอบ key สำหรับ member map ตาม marketCode + ownerCardId + ownerLineUserId + memberLineUserId
function buildMemberStallKey(
  marketCode: string,
  ownerCardId: string,
  ownerLineUserId: string,
  memberLineUserId: string,
): string {
  return `${marketCode}::${ownerCardId}::${ownerLineUserId}::${memberLineUserId}`;
}

// Function resolve ผู้กด Reject ผ่าน LINE ของ Submission หนึ่งรายการ เช็ค Owner map ก่อน แล้ว fallback ไปหา Member map ถ้า lineUserId ไม่ตรง Owner
function resolveRejectionActor(
  owner: HistoryOwnerStallInfo | null,
  marketCode: string,
  resolvedByLineUserId: string | null,
  memberNameByKey: Map<string, string | null>,
): { rejected_by_type: "owner" | "member" | null; rejected_by_name: string | null } {
  if (!resolvedByLineUserId) {
    // ไม่มี LINE user id แปลว่าเป็น Auto Timeout Confirm ไม่ใช่ Manual Reject ห้ามเดา Vendor
    return { rejected_by_type: null, rejected_by_name: null };
  }

  if (owner?.line_user_id === resolvedByLineUserId) {
    return { rejected_by_type: "owner", rejected_by_name: owner.full_name };
  }

  if (owner?.line_user_id) {
    const memberKey = buildMemberStallKey(
      marketCode,
      owner.card_id,
      owner.line_user_id,
      resolvedByLineUserId,
    );
    const memberName = memberNameByKey.get(memberKey);

    if (memberName !== undefined) {
      return { rejected_by_type: "member", rejected_by_name: memberName };
    }
  }

  return { rejected_by_type: null, rejected_by_name: null };
}

// Function คำนวณ company_share_rate ของ Booth หนึ่งใบ: (fund_amount / labor_fee_raw) * 100
function calculateCompanyShareRate(laborFeeRaw: string, fundAmount: string): string {
  const laborFeeRawDecimal = new Prisma.Decimal(laborFeeRaw);

  if (laborFeeRawDecimal.isZero()) {
    return "0.00";
  }

  return new Prisma.Decimal(fundAmount)
    .dividedBy(laborFeeRawDecimal)
    .times(100)
    .toFixed(2);
}

// Function ระบุประเภทการ Confirm ล่าสุดของ Submission: "vendor" ถ้ามี resolvedByLineUserId (กดเอง),
// "timeout" ถ้าไม่มี (Auto-confirm จาก BullMQ), null ถ้ายังไม่เคย Confirm
function resolveConfirmedByType(
  submission: AdminTicketJobHistoryRecord["marketJobs"][number]["tickets"][number]["completionSubmissions"][number] | null,
): "vendor" | "timeout" | null {
  if (!submission?.confirmedAt) {
    return null;
  }

  return submission.resolvedByLineUserId ? "vendor" : "timeout";
}

// Function จัดรูปแบบ SubmissionWorkerSnapshot[] ของ submission หนึ่งรายการ (roster ที่ WORKING ณ เวลา Submit จริง)
function formatSubmissionWorkerSnapshot(
  submission: AdminTicketJobHistoryRecord["marketJobs"][number]["tickets"][number]["completionSubmissions"][number],
): AdminHistoryBoothResponse["submission_worker_snapshot"] {
  return submission.workerSnapshots.map((snapshot) => ({
    worker_code: snapshot.ticketWorker.worker.laborCode,
    full_name: snapshot.ticketWorker.worker.fullName ?? snapshot.ticketWorker.worker.laborCode,
  }));
}

// Function ดึง WorkerCode ของผู้ส่งยอด (Admin หรือ Worker แล้วแต่ submittedByRole) ใน service flow
function resolveSubmitterCode(
  submission: AdminTicketJobHistoryRecord["marketJobs"][number]["tickets"][number]["completionSubmissions"][number],
): string | null {
  return submission.submittedByRole === TICKET_SUBMITTER_ROLE.ADMIN
    ? submission.submittedByAccount?.username ?? null
    : submission.submittedByWorker?.laborCode ?? null;
}

// Function ดึงชื่อเต็มของผู้ส่งยอด (Admin หรือ Worker แล้วแต่ submittedByRole) ใน service flow
function resolveSubmitterName(
  submission: AdminTicketJobHistoryRecord["marketJobs"][number]["tickets"][number]["completionSubmissions"][number],
): string | null {
  return submission.submittedByRole === TICKET_SUBMITTER_ROLE.ADMIN
    ? submission.submittedByAccount?.fullName ?? null
    : submission.submittedByWorker?.fullName ?? null;
}

// Function จัดรูปแบบ Booth หนึ่งใบสำหรับ Work History โดย reuse formatAdminFinancialBooth
// (คำนวณเงินเหมือนหน้า /financials ห้ามคำนวณสูตรใหม่) แล้วเติมข้อมูลการส่งยอด/Reject เพิ่ม
function formatAdminHistoryBooth(
  ticket: AdminTicketJobHistoryRecord["marketJobs"][number]["tickets"][number],
  market: AdminTicketJobHistoryRecord["marketJobs"][number],
  ownerByBoothKey: Map<string, HistoryOwnerStallInfo>,
  memberNameByKey: Map<string, string | null>,
  adminActionLogs: AdminActionLogDto[],
  isVehicleReleased: boolean,
): AdminHistoryBoothResponse {
  // ตัด ticket_id/ticket_no/marketCode/marketName ออก เพราะ Work History มีข้อมูลชุดนี้แล้วระดับ Markets[]
  const { ticket_id: _ticketId, ticket_no: _ticketNo, marketCode: _marketCode, marketName: _marketName, products: financialProducts, ...base } =
    formatAdminFinancialBooth(ticket, market);
  const products: AdminHistoryProductResponse[] = financialProducts.map(
    ({ ticket_product_id: _ticketProductId, ...product }) => product,
  );
  const submissions = ticket.completionSubmissions;
  const latestSubmission =
    submissions.length > 0 ? submissions[submissions.length - 1] : null;
  const submittedByCodes = [
    ...new Set(
      submissions
        .map((submission) => resolveSubmitterCode(submission))
        .filter((code): code is string => code !== null),
    ),
  ];
  const owner = ownerByBoothKey.get(buildOwnerStallKey(market.marketCode, ticket.boothCode)) ?? null;
  const rejectionHistory: AdminHistoryRejectionResponse[] = [];

  submissions.forEach((submission) => {
    if (!submission.rejectedAt) {
      return;
    }

    const rejectionActor = resolveRejectionActor(
      owner,
      market.marketCode,
      submission.resolvedByLineUserId,
      memberNameByKey,
    );

    rejectionHistory.push({
      rejectedAt: submission.rejectedAt.toISOString(),
      // Current Master Owner ของ Booth นี้ ไม่ใช่ Historical Snapshot
      correction_owner: owner?.full_name ?? null,
      // ทีมยังไม่ Release แก้เองได้ (worker) ทีม Release ไปแล้วต้อง Admin จัดการแทน (admin)
      correction_owner_type: isVehicleReleased ? "admin" : "worker",
      rejected_by_type: rejectionActor.rejected_by_type,
      rejected_by_name: rejectionActor.rejected_by_name,
    });
  });

  return {
    ...base,
    products,
    vendor_line_id: ticket.vendorLineId,
    submitted_by_codes: submittedByCodes,
    submitted_by_role:
      (latestSubmission?.submittedByRole as "worker" | "admin" | undefined) ?? null,
    latest_submitted_by_code: latestSubmission ? resolveSubmitterCode(latestSubmission) : null,
    latest_submitted_by_name: latestSubmission ? resolveSubmitterName(latestSubmission) : null,
    submission_worker_snapshot: latestSubmission
      ? formatSubmissionWorkerSnapshot(latestSubmission)
      : [],
    submitted_at: latestSubmission?.createdAt.toISOString() ?? null,
    confirmedAt: latestSubmission?.confirmedAt?.toISOString() ?? null,
    confirmed_by_type: resolveConfirmedByType(latestSubmission),
    rejection_history: rejectionHistory,
    company_share_rate: calculateCompanyShareRate(
      base.summary.labor_fee_raw,
      base.summary.fund_amount,
    ),
    // จำนวน Worker WORKING ณ ตอน Submission ล่าสุด (Historical Snapshot) ห้าม fallback ไปนับ Worker ปัจจุบัน
    worker_count: latestSubmission?.workerCountSnapshot ?? null,
    cancellation: formatCancellationResponse(
      ticket.status === TICKET_STATUS.CANCELLED,
      findBoothCancelLog(adminActionLogs, ticket.id, market.id),
    ),
  };
}

// Function สร้าง Job-level Worker Earnings: GROUP BY workerId แล้ว SUM(TicketWorker.finalEarningAmount)
// ของทุก MarketJob ในรถคันนี้ นับเฉพาะที่ finalize แล้ว คนที่ timeout ก่อน Scan จะไม่โผล่ในผลลัพธ์
function buildAdminHistoryJobWorkerEarnings(
  record: AdminTicketJobHistoryRecord,
): Array<{
  worker_id: number;
  worker_code: string | null;
  full_name: string;
  total_amount: string;
}> {
  const totalByWorkerId = new Map<number, Prisma.Decimal>();
  const workerById = new Map<
    number,
    AdminTicketJobHistoryRecord["marketJobs"][number]["ticketWorkers"][number]["worker"]
  >();

  for (const market of record.marketJobs) {
    for (const ticketWorker of market.ticketWorkers) {
      if (ticketWorker.finalEarningAmount === null) {
        continue;
      }

      const existing = totalByWorkerId.get(ticketWorker.workerId) ?? new Prisma.Decimal(0);

      totalByWorkerId.set(ticketWorker.workerId, existing.plus(ticketWorker.finalEarningAmount));
      workerById.set(ticketWorker.workerId, ticketWorker.worker);
    }
  }

  return Array.from(totalByWorkerId.entries()).map(([workerId, totalAmount]) => {
    const worker = workerById.get(workerId);

    return {
      worker_id: workerId,
      worker_code: worker?.laborCode ?? null,
      full_name: worker?.fullName ?? worker?.laborCode ?? "",
      total_amount: totalAmount.toFixed(2),
    };
  });
}

// Function derive HistoryStatus ต่อ record ต้องตรงกับ buildHistoryStatusFilter ใน
// admin-jobs.repository.ts เสมอ (ลำดับความสำคัญ CANCELLED → COMPLETED → REJECT_PENDING)
function deriveHistoryStatus(record: AdminTicketJobHistoryRecord): HistoryStatusValue | null {
  if (record.status === VEHICLE_JOB_STATUS.CANCELLED) {
    return "CANCELLED";
  }

  if (record.status === VEHICLE_JOB_STATUS.COMPLETED) {
    return "COMPLETED";
  }

  const hasPendingReject = record.marketJobs.some((market) =>
    market.tickets.some((ticket) => ticket.status === TICKET_STATUS.REJECT),
  );

  if (!TERMINAL_JOB_STATUSES.includes(record.status) && hasPendingReject) {
    return "REJECT_PENDING";
  }

  return null;
}

// Function รวม TicketCompletionSubmission ทุกใบของทุก Booth ในรถคันนี้เป็นชุดเดียว ใช้ร่วมกันใน deriveHistoryFlags
function collectAllCompletionSubmissions(
  record: AdminTicketJobHistoryRecord,
): AdminTicketJobHistoryRecord["marketJobs"][number]["tickets"][number]["completionSubmissions"] {
  return record.marketJobs.flatMap((market) =>
    market.tickets.flatMap((ticket) => ticket.completionSubmissions),
  );
}

// Function derive HistoryFlags ของ record (เหตุการณ์สำคัญย้อนหลังที่เคยเกิด คนละความหมายกับสถานะปัจจุบันใน deriveHistoryStatus)
// ลำดับค่าที่คืนต้องตรงกับ HISTORY_FLAG_VALUES เสมอ และห้าม derive จากข้อความ Timeline/Description
function deriveHistoryFlags(record: AdminTicketJobHistoryRecord): HistoryFlagValue[] {
  const submissions = collectAllCompletionSubmissions(record);
  const allTickets = record.marketJobs.flatMap((market) => market.tickets);

  const isFlagActive: Record<HistoryFlagValue, boolean> = {
    FINANCE_CALCULATED: allTickets.some(
      (ticket) => ticket.financializedAt !== null,
    ),
    WORKERS_RELEASED: record.assignments.some(
      (assignment) => assignment.releasedAt !== null,
    ),
    // ต้องตรวจทุก submission ไม่ใช่แค่ BoothJob.status ปัจจุบัน — งานที่เคย Reject แล้วแก้สำเร็จ
    // (status ปัจจุบันไม่ใช่ REJECT แล้ว) ยังต้องติด flag นี้อยู่
    BOOTH_REJECTED: submissions.some(
      (submission) => submission.rejectedAt !== null,
    ),
    // ไม่มี resolvedByLineUserId แปลว่าเป็น BullMQ Timeout auto-confirm (เดียวกับ resolveConfirmedByType)
    AUTO_CONFIRMED: submissions.some(
      (submission) =>
        submission.confirmedAt !== null && submission.resolvedByLineUserId === null,
    ),
    // นับเฉพาะ assignment ที่กดรับงานแล้วถูก ADMIN_CANCELLED (dispatch ที่ยกเลิกก่อนกดรับไม่นับ)
    WORKER_CHANGED_DURING_JOB: record.assignments.some(
      (assignment) =>
        assignment.acceptedAt !== null &&
        assignment.events.some(
          (event) => event.eventType === WORKER_ASSIGNMENT_EVENT_TYPE.ADMIN_CANCELLED,
        ),
    ),
    // ใช้ workerCountSnapshot ณ เวลา Submit เท่านั้น ข้าม submission เก่าที่ไม่มีค่านี้ ห้าม fallback จาก roster ปัจจุบัน
    SUBMISSION_ROSTER_INCOMPLETE: submissions.some(
      (submission) =>
        submission.workerCountSnapshot !== null &&
        submission.workerCountSnapshot < record.workersRequired,
    ),
    ADMIN_SUBMITTED_ON_BEHALF: submissions.some(
      (submission) => submission.submittedByRole === TICKET_SUBMITTER_ROLE.ADMIN,
    ),
    // สอง flag นี้ mutually exclusive กันเอง (แยกกันด้วย workStartedAt เป็น null หรือไม่)
    VEHICLE_CANCELLED_AFTER_START:
      record.status === VEHICLE_JOB_STATUS.CANCELLED && record.workStartedAt !== null,
    VEHICLE_CANCELLED_BEFORE_START:
      record.status === VEHICLE_JOB_STATUS.CANCELLED && record.workStartedAt === null,
  };

  return HISTORY_FLAG_VALUES.filter((flag) => isFlagActive[flag]);
}

// Function จัดรูปแบบ Work History แบบละเอียดของ TicketJob หนึ่งคัน ใน service flow
function formatAdminTicketJobHistoryDetail(
  record: AdminTicketJobHistoryRecord,
  adminActionLogs: AdminActionLogDto[],
  ownerByBoothKey: Map<string, HistoryOwnerStallInfo>,
  memberNameByKey: Map<string, string | null>,
): AdminTicketJobHistoryItemResponse {
  const historyStatus = deriveHistoryStatus(record);
  const historyFlags = deriveHistoryFlags(record);
  const isVehicleReleased = record.status === VEHICLE_JOB_STATUS.RELEASED;
  const markets = record.marketJobs.map((market) => ({
    ticket_no: market.ticketNo,
    marketCode: market.marketCode,
    marketName: market.marketName,
    dropoff_point: market.dropoffPoint,
    status: market.status,
    cancellation: formatCancellationResponse(
      market.status === VEHICLE_JOB_STATUS.CANCELLED,
      findMarketCancelLog(adminActionLogs, market.id),
    ),
    booths: market.tickets.map((ticket) =>
      formatAdminHistoryBooth(
        ticket,
        market,
        ownerByBoothKey,
        memberNameByKey,
        adminActionLogs,
        isVehicleReleased,
      ),
    ),
  }));
  const booths = markets.flatMap((market) => market.booths);
  const jobTimestamps = deriveAdminHistoryJobTimestamps(record);
  const { stallFeeTotal, laborFeeTotal, workerPayoutTotal: totalWorkerShare, fundAmount } =
    sumBoothFinancials(booths);

  // ชุดเดียวกับ Workers[] (formatAdminHistoryWorkers) เสมอ — คนที่กดรับงานจริงและไม่ซ้ำต่อคน
  const financeWorkers = buildAdminHistoryJobWorkerEarnings(record);

  return {
    vehicle_job: {
      ticket_number: record.ticketNumber,
      plate_no: record.licensePlate,
      plate_province: record.licensePlateProvince,
      vehicle_type: record.vehicleType,
      workers_required: record.workersRequired,
      dispatch_now: record.dispatchNow,
      status: record.status,
      history_status: historyStatus,
      history_flags: historyFlags,
      cancellation: formatCancellationResponse(
        record.status === VEHICLE_JOB_STATUS.CANCELLED,
        findVehicleCancelLog(adminActionLogs),
      ),
      ...jobTimestamps,
    },
    markets,
    workers: formatAdminHistoryWorkers(record, adminActionLogs),
    timeline: formatAdminHistoryTimeline(record, adminActionLogs, jobTimestamps),
    finance: {
      stall_fee_total: stallFeeTotal.toFixed(2),
      labor_fee_total: laborFeeTotal.toFixed(4),
      total_worker_share: totalWorkerShare.toFixed(2),
      fund_amount: fundAmount.toFixed(4),
      worker_count: financeWorkers.length,
      workers: financeWorkers,
    },
  };
}


// Function จัดรูปแบบ market job action response ใน service flow
function formatMarketJobActionResponse(
  message: string,
  market: MarketJobDto,
  ticketJob: TicketJobDto | null,
): AdminMarketJobActionResponse {
  return {
    message,
    ticket_number: ticketJob?.ticket_number ?? null,
    ticket_no: market.ticket_no,
    marketCode: market.marketCode,
    status: market.status,
  };
}

// Function จัดรูปแบบ stall job action response ใน service flow
function formatStallJobActionResponse(
  message: string,
  ticket: BoothJobDto,
  ticketJob: TicketJobDto | null,
  marketJob: MarketJobDto | null,
): AdminStallJobActionResponse {
  return {
    message,
    ticket_number: ticketJob?.ticket_number ?? null,
    ticket_no: marketJob?.ticket_no ?? null,
    marketCode: marketJob?.marketCode ?? null,
    boothCode: ticket.boothCode,
    status: ticket.status,
    confirmation_status: ticket.confirmation_status,
  };
}

// Function จัดสถานะ Financial ระดับ TicketJob
function resolveTicketJobFinancialStatus(
  boothCount: number,
  financializedBoothCount: number,
): AdminTicketJobFinancialResponse["financial_status"] {
  if (financializedBoothCount === 0) {
    return "PENDING";
  }

  if (financializedBoothCount < boothCount) {
    return "PARTIAL";
  }

  return "FINALIZED";
}

// Function จัดรูปแบบ Product Financial สำหรับ Admin
function formatAdminFinancialProduct(
  product: AdminTicketJobFinancialRecord["marketJobs"][number]["tickets"][number]["products"][number],
): AdminTicketJobFinancialResponse["booths"][number]["products"][number] {
  const financial = product.financial;

  return {
    ticket_product_id: product.id,
    productCode: product.productCode,
    productFullCode: product.productFullCode,
    productName: product.productName,
    packageCode: product.packageCode,
    packageName: product.packageName,
    quantity: product.quantity.toFixed(2),
    confirmed_quantity: product.confirmedQuantity?.toFixed(2) ?? null,
    rate_snapshot: {
      package_weight_snapshot:
        product.packageWeightSnapshot?.toFixed(2) ?? null,
      rate_id_snapshot: product.rateIdSnapshot,
      source_rate_id_snapshot: product.sourceRateIdSnapshot,
      rate_market_code: product.rateMarketCode,
      rate_source: product.rateSource,
      weight_range_name: product.weightRangeName,
      weight_min_snapshot: product.weightMinSnapshot?.toFixed(2) ?? null,
      weight_max_snapshot: product.weightMaxSnapshot?.toFixed(2) ?? null,
      stall_rate_snapshot: product.stallRateSnapshot?.toFixed(2) ?? null,
      labor_rate_snapshot: product.laborRateSnapshot?.toFixed(2) ?? null,
      rate_snapshot_at: product.rateSnapshotAt?.toISOString() ?? null,
    },
    financial: financial
      ? {
          stall_fee_raw: financial.stallFeeRaw.toFixed(4),
          stall_fee_rounded: financial.stallFeeRounded.toFixed(2),
          labor_fee_raw: financial.laborFeeRaw.toFixed(4),
          product_charge: financial.productCharge.toFixed(2),
          worker_count: financial.workerCount,
          worker_payout_total: financial.workerPayoutTotal.toFixed(2),
          fund_amount: financial.fundAmount.toFixed(4),
          finalized_at: financial.finalizedAt.toISOString(),
        }
      : null,
    workers:
      financial?.workerPayments.map((payment) => ({
        ticket_worker_id: payment.ticketWorker.id,
        worker_code: payment.ticketWorker.worker.laborCode,
        full_name: payment.ticketWorker.worker.fullName ?? payment.ticketWorker.worker.laborCode,
        membership_status: payment.ticketWorker.status,
        raw_amount: payment.rawAmount.toFixed(8),
        remainder_amount: payment.remainderAmount.toFixed(8),
        final_amount: payment.finalAmount.toFixed(2),
      })) ?? [],
  };
}

// Function จัดรูปแบบ Booth Financial สำหรับ Admin — Worker Roster อยู่ระดับ Business Ticket ไม่ใช่ระดับ Booth
// จึงต้องรวมยอดจาก product.financial.workerPayments ของ Booth นี้เท่านั้น ห้ามใช้ ticketWorker.payments ตรงๆ (จะรวมข้าม Booth)
function formatAdminFinancialBooth(
  ticket: AdminTicketJobFinancialRecord["marketJobs"][number]["tickets"][number],
  marketJob: AdminTicketJobFinancialRecord["marketJobs"][number],
): AdminTicketJobFinancialResponse["booths"][number] {
  let laborFeeRaw = new Prisma.Decimal(0);
  let workerPayoutTotal = new Prisma.Decimal(0);
  let fundAmount = new Prisma.Decimal(0);

  const boothWorkerTotals = new Map<
    number,
    {
      worker_code: string;
      full_name: string;
      membership_status: string;
      total: Prisma.Decimal;
    }
  >();

  for (const product of ticket.products) {
    if (!product.financial) {
      continue;
    }

    laborFeeRaw = laborFeeRaw.plus(product.financial.laborFeeRaw);
    workerPayoutTotal = workerPayoutTotal.plus(
      product.financial.workerPayoutTotal,
    );
    fundAmount = fundAmount.plus(product.financial.fundAmount);

    for (const payment of product.financial.workerPayments) {
      const existing = boothWorkerTotals.get(payment.ticketWorker.id);
      const total = (existing?.total ?? new Prisma.Decimal(0)).plus(
        payment.finalAmount,
      );

      boothWorkerTotals.set(payment.ticketWorker.id, {
        worker_code: payment.ticketWorker.worker.laborCode,
        full_name: payment.ticketWorker.worker.fullName ?? payment.ticketWorker.worker.laborCode,
        membership_status: payment.ticketWorker.status,
        total,
      });
    }
  }

  // แสดง Worker ทั้งหมดของ Business Ticket แม้ total_amount ของ Booth นี้จะเป็น 0
  for (const ticketWorker of marketJob.ticketWorkers) {
    if (boothWorkerTotals.has(ticketWorker.id)) {
      continue;
    }

    boothWorkerTotals.set(ticketWorker.id, {
      worker_code: ticketWorker.worker.laborCode,
      full_name: ticketWorker.worker.fullName ?? ticketWorker.worker.laborCode,
      membership_status: ticketWorker.status,
      total: new Prisma.Decimal(0),
    });
  }

  const workers = Array.from(boothWorkerTotals.entries()).map(
    ([ticketWorkerId, { worker_code, full_name, membership_status, total }]) => ({
      ticket_worker_id: ticketWorkerId,
      worker_code,
      full_name,
      membership_status,
      total_amount: total.toFixed(2),
    }),
  );

  return {
    ticket_id: ticket.id,
    ticket_no: marketJob.ticketNo,
    marketCode: marketJob.marketCode,
    marketName: marketJob.marketName,
    boothCode: ticket.boothCode,
    boothName: ticket.boothName,
    status: ticket.status,
    financialized: ticket.financializedAt !== null,
    final_stall_amount: ticket.finalStallAmount?.toFixed(2) ?? null,
    completed_at: ticket.completedAt?.toISOString() ?? null,
    summary: {
      labor_fee_raw: laborFeeRaw.toFixed(4),
      worker_payout_total: workerPayoutTotal.toFixed(2),
      fund_amount: fundAmount.toFixed(4),
    },
    workers,
    products: ticket.products.map(formatAdminFinancialProduct),
  };
}

// Function รวมยอด stall/labor/worker-payout/fund ของ Booth[] เป็นยอดรวมระดับ Vehicle Job
// ใช้ร่วมกันระหว่าง Work History และ Financials เพื่อให้สูตรรวมตรงกันเป๊ะ
function sumBoothFinancials(
  booths: {
    final_stall_amount: string | null;
    summary: {
      labor_fee_raw: string;
      worker_payout_total: string;
      fund_amount: string;
    };
  }[],
): {
  stallFeeTotal: Prisma.Decimal;
  laborFeeTotal: Prisma.Decimal;
  workerPayoutTotal: Prisma.Decimal;
  fundAmount: Prisma.Decimal;
} {
  let stallFeeTotal = new Prisma.Decimal(0);
  let laborFeeTotal = new Prisma.Decimal(0);
  let workerPayoutTotal = new Prisma.Decimal(0);
  let fundAmount = new Prisma.Decimal(0);

  for (const booth of booths) {
    if (booth.final_stall_amount !== null) {
      stallFeeTotal = stallFeeTotal.plus(booth.final_stall_amount);
    }

    laborFeeTotal = laborFeeTotal.plus(booth.summary.labor_fee_raw);
    workerPayoutTotal = workerPayoutTotal.plus(booth.summary.worker_payout_total);
    fundAmount = fundAmount.plus(booth.summary.fund_amount);
  }

  return { stallFeeTotal, laborFeeTotal, workerPayoutTotal, fundAmount };
}

// Function ตรวจสอบและดึง vehicle job ตาม ref ใน service flow
async function requireTicketJobByRef(
  idParam: unknown,
  connection?: Parameters<typeof ticketJobRepository.findTicketJobByRef>[1],
): Promise<TicketJobDto> {
  const ticketNumber = parseReference(
    idParam,
    "INVALID_VEHICLE_JOB_REF",
    "TicketNumber is invalid.",
  );
  const ticketJob = await ticketJobRepository.findTicketJobByRef(
    ticketNumber,
    connection,
  );

  if (!ticketJob) {
    throw new ApiError(404, "VEHICLE_JOB_NOT_FOUND", "Vehicle job not found.");
  }

  return ticketJob;
}

// Function จัดการ assignment queue priority at ใน service flow
function assignmentQueuePriorityAt(
  assignment: TicketJobAssignmentDto,
): number {
  const value = assignment.accepted_at ?? assignment.created_at;
  const timestamp = value
    ? new Date(value).getTime()
    : Number.POSITIVE_INFINITY;

  return Number.isNaN(timestamp) ? Number.POSITIVE_INFINITY : timestamp;
}

// Function เรียง assignments ตาม accepted_at (fallback created_at) ใช้ร่วมกันทุกจุดที่ requeue Worker
// กลับเข้าคิว ลำดับสัมพัทธ์ต้องอิงเวลากดรับงานเสมอ ไม่ใช่ลำดับที่ assignment ถูกสร้าง/dispatch
function sortAssignmentsByAcceptedAt(
  assignments: TicketJobAssignmentDto[],
): TicketJobAssignmentDto[] {
  return [...assignments].sort((left, right) => {
    const leftPriorityAt = assignmentQueuePriorityAt(left);
    const rightPriorityAt = assignmentQueuePriorityAt(right);

    if (leftPriorityAt !== rightPriorityAt) {
      return leftPriorityAt - rightPriorityAt;
    }

    return left.id - right.id;
  });
}

// Function ต่อเวลา deadline ใน service flow
function extendDeadline(currentDeadline: string | null, minutes: number): Date {
  const now = Date.now();
  const currentTime = currentDeadline
    ? new Date(currentDeadline).getTime()
    : now;
  const baseTime = Math.max(now, currentTime);

  return new Date(baseTime + minutes * 60 * 1000);
}

// Function ตรวจว่า scan deadline active ใน service flow
function isScanDeadlineActive(scanDeadlineAt: string | null): boolean {
  if (!scanDeadlineAt) {
    return false;
  }

  const deadlineMs = new Date(scanDeadlineAt).getTime();

  return Number.isFinite(deadlineMs) && deadlineMs > Date.now();
}

// Function สร้าง scan deadline assignment responses ใน service flow
async function buildScanDeadlineAssignmentResponses(
  assignments: TicketJobAssignmentDto[],
): Promise<AdminScanDeadlineAssignmentResponse[]> {
  const workerCodeMap = await profileRepository.findWorkerCodeMapByAccountIds(
    assignments.map((assignment) => assignment.worker_id),
  );

  return assignments.map((assignment) => ({
    worker_code: workerCodeMap.get(assignment.worker_id) ?? null,
    status: assignment.status,
    scan_deadline_at: assignment.scan_deadline_at,
    scan_deadline_unix_ms: toUnixMs(assignment.scan_deadline_at),
  }));
}

// Function สร้าง admin assignment responses ใน service flow
async function buildAdminAssignmentResponses(
  ticketNumber: string,
  assignments: TicketJobAssignmentDto[],
): Promise<AdminAssignmentResponse[]> {
  const workerCodeMap = await profileRepository.findWorkerCodeMapByAccountIds(
    assignments.map((assignment) => assignment.worker_id),
  );

  return assignments.map((assignment) => ({
    ticket_number: ticketNumber,
    worker_code: workerCodeMap.get(assignment.worker_id) ?? null,
    status: assignment.status,
    accept_deadline_at: assignment.accept_deadline_at,
    accept_deadline_unix_ms: toUnixMs(assignment.accept_deadline_at),
    scan_deadline_at: assignment.scan_deadline_at,
    scan_deadline_unix_ms: toUnixMs(assignment.scan_deadline_at),
    created_at: assignment.created_at,
    updated_at: assignment.updated_at,
  }));
}

// Function ดึงรายการ vehicle job worker IDs ใน service flow
async function listTicketJobWorkerIds(
  ticketJobId: number,
): Promise<number[]> {
  const assignments =
    await assignmentRepository.listActiveAssignmentsByTicketJob(ticketJobId);

  return [
    ...new Set(assignments.map((assignment) => assignment.worker_id)),
  ];
}

// Function ดึงรายการ stall job worker IDs ใน service flow
async function listStallJobWorkerIds(ticket: BoothJobDto): Promise<number[]> {
  const ticketWorkers = await ticketWorkerRepository.listTicketWorkers(
    ticket.market_job_id,
  );

  if (ticketWorkers.length > 0) {
    return [
      ...new Set(ticketWorkers.map((worker) => worker.worker_id)),
    ];
  }

  return listTicketJobWorkerIds(ticket.vehicle_job_id);
}

// Function ดึง Financial breakdown ของ TicketJob สำหรับ Admin
export async function getTicketJobFinancials(
  ticketNumberParam: unknown,
): Promise<AdminTicketJobFinancialResponse> {
  const ticketNumber = parseReference(
    ticketNumberParam,
    "INVALID_VEHICLE_JOB_REF",
    "TicketNumber is invalid.",
  );

  const ticketJob =
    await adminJobsRepository.findTicketJobFinancialByRef(ticketNumber);

  if (!ticketJob) {
    throw new ApiError(404, "VEHICLE_JOB_NOT_FOUND", "Vehicle job not found.");
  }

  const booths = ticketJob.marketJobs.flatMap((market) =>
    market.tickets.map((ticket) => formatAdminFinancialBooth(ticket, market)),
  );
  const financializedBoothCount = booths.filter(
    (booth) => booth.financialized,
  ).length;

  const {
    stallFeeTotal: finalStallAmount,
    laborFeeTotal: laborFeeRaw,
    workerPayoutTotal,
    fundAmount,
  } = sumBoothFinancials(booths);

  return {
    vehicle_job: {
      ticket_number: ticketJob.ticketNumber,
      license_plate: ticketJob.licensePlate,
      license_plate_province: ticketJob.licensePlateProvince,
      vehicle_type: ticketJob.vehicleType,
      status: ticketJob.status,
    },
    financial_status: resolveTicketJobFinancialStatus(
      booths.length,
      financializedBoothCount,
    ),
    summary: {
      booth_count: booths.length,
      financialized_booth_count: financializedBoothCount,
      final_stall_amount: finalStallAmount.toFixed(2),
      labor_fee_raw: laborFeeRaw.toFixed(4),
      worker_payout_total: workerPayoutTotal.toFixed(2),
      fund_amount: fundAmount.toFixed(4),
    },
    booths,
  };
}

// Function Batch-fetch ผู้ที่กด Reject ผ่าน LINE (Owner/Member) ของทุก Booth ที่มี Rejection History
// ในหน้า Vehicle Job list นี้ — query ครั้งเดียวต่อหน้า ไม่ query ต่อแถว/ต่อ Booth
async function buildHistoryRejectionActorContext(
  records: AdminTicketJobHistoryRecord[],
): Promise<{
  ownerByBoothKey: Map<string, HistoryOwnerStallInfo>;
  memberNameByKey: Map<string, string | null>;
}> {
  const boothPairs = new Map<string, { marketCode: string; boothCode: string }>();

  for (const record of records) {
    for (const market of record.marketJobs) {
      for (const ticket of market.tickets) {
        if (ticket.completionSubmissions.some((submission) => submission.rejectedAt)) {
          boothPairs.set(buildOwnerStallKey(market.marketCode, ticket.boothCode), {
            marketCode: market.marketCode,
            boothCode: ticket.boothCode,
          });
        }
      }
    }
  }

  const ownerByBoothKey = await masterDataRepository.findOwnerStallsByMarketAndBooth(
    Array.from(boothPairs.values()),
  );

  const memberRequests: Array<{
    marketCode: string;
    ownerCardId: string;
    ownerLineUserId: string;
    memberLineUserId: string;
  }> = [];
  const seenMemberKeys = new Set<string>();

  for (const record of records) {
    for (const market of record.marketJobs) {
      for (const ticket of market.tickets) {
        for (const submission of ticket.completionSubmissions) {
          if (!submission.rejectedAt || !submission.resolvedByLineUserId) {
            continue;
          }

          const owner = ownerByBoothKey.get(
            buildOwnerStallKey(market.marketCode, ticket.boothCode),
          );

          if (!owner?.line_user_id || owner.line_user_id === submission.resolvedByLineUserId) {
            continue;
          }

          const key = buildMemberStallKey(
            market.marketCode,
            owner.card_id,
            owner.line_user_id,
            submission.resolvedByLineUserId,
          );

          if (seenMemberKeys.has(key)) {
            continue;
          }

          seenMemberKeys.add(key);
          memberRequests.push({
            marketCode: market.marketCode,
            ownerCardId: owner.card_id,
            ownerLineUserId: owner.line_user_id,
            memberLineUserId: submission.resolvedByLineUserId,
          });
        }
      }
    }
  }

  const memberNameByKey =
    await masterDataRepository.findMemberStallFullNamesByOwnerAndLineUserId(memberRequests);

  return { ownerByBoothKey, memberNameByKey };
}

// Function ดึงรายการ vehicle jobs ใน service flow
export async function listTicketJobs(query: unknown): Promise<{
  data: AdminTicketJobHistoryItemResponse[];
  available_dropoff_points: string[];
  pagination?: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
}> {
  const filters = parseWithSchema(adminTicketJobListQuerySchema, query);
  const dateFrom = filters.date ?? filters.date_from;
  const dateTo = filters.date ?? filters.date_to;
  const dateRange = buildBangkokDateSpanRange(dateFrom, dateTo);
  const result = await adminJobsRepository.listTicketJobs({
    search: filters.search,
    status: filters.status,
    history_status: filters.history_status,
    dropoff_point: filters.dropoff_point,
    page: filters.page,
    limit: filters.limit,
    ...dateRange,
  });
  const adminActionLogsByTicketJobId = new Map<number, AdminActionLogDto[]>(
    await Promise.all(
      result.data.map(async (ticketJob) => {
        const logs = await adminActionLogRepository.listByTicketJobId(ticketJob.id);

        return [ticketJob.id, logs] as const;
      }),
    ),
  );
  const { ownerByBoothKey, memberNameByKey } = await buildHistoryRejectionActorContext(
    result.data,
  );
  const formatItem = (ticketJob: (typeof result.data)[number]) =>
    formatAdminTicketJobHistoryDetail(
      ticketJob,
      adminActionLogsByTicketJobId.get(ticketJob.id) ?? [],
      ownerByBoothKey,
      memberNameByKey,
    );

  if (filters.page === undefined) {
    return {
      data: result.data.map(formatItem),
      available_dropoff_points: result.available_dropoff_points,
    };
  }

  const limit = filters.limit ?? DEFAULT_PAGE_LIMIT;
  const total = result.total ?? result.data.length;

  return {
    data: result.data.map(formatItem),
    available_dropoff_points: result.available_dropoff_points,
    pagination: {
      page: filters.page,
      limit,
      total,
      total_pages: Math.ceil(total / limit),
    },
  };
}

// Function ดึงรายการ vehicle job operations ใน service flow
export async function listTicketJobOperations(
  query: unknown,
): Promise<AdminTicketJobOperationListResponse> {
  const filters = parseWithSchema(adminTicketJobOperationsQuerySchema, query);
  const dateFrom = filters.date ?? filters.date_from;
  const dateTo = filters.date ?? filters.date_to;
  const dateRange = buildBangkokDateSpanRange(
    dateFrom,
    dateTo,
    filters.time_from,
    filters.time_to
  );
  const { records, available_dropoff_points } = await adminJobsRepository.listTicketJobOperations({
    search: filters.search,
    operation_status: filters.operation_status,
    dropoff_point: filters.dropoff_point,
    page: filters.page,
    limit: filters.limit,
    ...dateRange,
  });
  const items = records.map(formatVehicleOperationItem);
  const summary = buildVehicleOperationSummary(items);
  const filteredItems = items
    .filter((item) =>
      filters.operation_status
        ? item.operation_status === filters.operation_status
        : true,
    )
    .filter((item) =>
      filters.status ? item.vehicle_job.status === filters.status : true,
    )
    .filter((item) =>
      filters.has_issue ? item.market_summary.rejected > 0 : true,
    );

  if (filters.page === undefined) {
    return {
      server_time: new Date().toISOString(),
      summary,
      data: filteredItems,
      available_dropoff_points,
    };
  }

  const limit = filters.limit ?? DEFAULT_PAGE_LIMIT;
  const start = (filters.page - 1) * limit;
  const pagedItems = filteredItems.slice(start, start + limit);

  return {
    server_time: new Date().toISOString(),
    summary,
    data: pagedItems,
    available_dropoff_points,
    pagination: {
      page: filters.page,
      limit,
      total: filteredItems.length,
      total_pages: Math.ceil(filteredItems.length / limit),
    },
  };
}

// Function ทำขั้นตอนร่วมของการยกเลิก vehicle job ทั้งคัน เรียกจาก cancelTicketJobAndRequeue ก่อน requeue worker
async function performTicketJobCancellation(
  idParam: unknown,
  body: unknown,
  actorId: number,
) {
  const existingTicketJob = await requireTicketJobByRef(idParam);
  const ticketJobId = existingTicketJob.id;
  const input = parseWithSchema(adminCancelBodySchema, body ?? {});

  const { ticketJob, activeAssignments, ticketNos, activeBooths } = await withTransaction(
    async (transaction) => {
      // Lock แถวรถก่อนอ่าน/ยกเลิก กัน race กับ closeCompletedTicketJobIfReady ที่อาจปิดรถพร้อมกันคนละ transaction
      await transaction.$queryRaw`SELECT id FROM ticket_jobs WHERE id = ${ticketJobId} FOR UPDATE`;

      const current = await ticketJobRepository.findTicketJobById(
        ticketJobId,
        transaction,
      );

      if (!current) {
        throw new ApiError(404, "VEHICLE_JOB_NOT_FOUND", "Vehicle job not found.");
      }

      if (TERMINAL_JOB_STATUSES.includes(current.status)) {
        throw new ApiError(
          409,
          "VEHICLE_JOB_CLOSED",
          "Vehicle job is already completed or cancelled.",
        );
      }

      // ห้ามยกเลิกทั้งรถ ถ้ามี Booth ไหนใต้รถคันนี้เคยถูกส่งยอดมาแล้ว ไม่ว่าผลจะเป็น DELIVERED (รอ Vendor)
      // หรือ REJECT (โดนปฏิเสธ) ก็ตาม — ต้องให้ส่งยอดใหม่จน Vendor ยืนยัน/timeout แทน (guard เดียวกับระดับ Business Ticket)
      const hasSubmittedTickets =
        await boothJobRepository.hasSubmittedActiveTicketsForTicketJob(
          ticketJobId,
          transaction,
        );

      if (hasSubmittedTickets) {
        throw new ApiError(
          409,
          "VEHICLE_JOB_ALREADY_SUBMITTED",
          "Vehicle job cannot be cancelled after a booth has already been submitted.",
        );
      }

      // ต้องดึงก่อน cancelTicketJob เท่านั้น เพราะ cancel ทำให้ MarketJob ทุกใบกลายเป็น CANCELLED ไปด้วย
      const activeAssignments =
        await assignmentRepository.listActiveAssignmentsByTicketJob(
          ticketJobId,
          transaction,
        );
      const ticketNos =
        await marketJobRepository.listActiveTicketNosByTicketJobId(
          ticketJobId,
          transaction,
        );
      // ดึงก่อน cancelTicketJob เช่นกัน เพราะ cascade จะทำให้ทุกแผงใต้รถคันนี้กลายเป็น CANCELLED ไปด้วย — ใช้แจ้ง LINE แผงหลัง commit
      const activeBooths = await boothJobRepository.listActiveBoothsByTicketJobId(
        ticketJobId,
        transaction,
      );

      const cancelled = await ticketJobLifecycleService.cancelTicketJob(
        ticketJobId,
        transaction,
      );

      // เพิกถอน driver session ที่ยัง active ของรถคันนี้ทันที (เหตุผลเดียวกับ closeCompletedTicketJobIfReady)
      await driverSessionRepository.revokeDriverSessionsByTicketJobId(
        ticketJobId,
        transaction,
      );

      await adminActionLogRepository.create(
        {
          vehicle_job_id: ticketJobId,
          action_type: ADMIN_ACTION_TYPE.VEHICLE_JOB_CANCELLED,
          reason_code: input.reason_code ?? null,
          reason_text: input.reason_text ?? null,
          actor_account_id: actorId,
        },
        transaction,
      );

      return { ticketJob: cancelled, activeAssignments, ticketNos, activeBooths };
    },
  );

  await Promise.all(
    activeAssignments.flatMap((assignment) => [
      removeAssignmentTimeout(assignment.id),
      removeScanTimeout(assignment.id),
      removeScanWarning(assignment.id),
    ]),
  );

  return { ticketJob, activeAssignments, ticketNos, activeBooths };
}

// Function ยกเลิก vehicle job และ requeue ใน service flow
async function cancelTicketJobAndRequeue(
  idParam: unknown,
  body: unknown,
  auth?: AccessTokenPayload,
): Promise<AdminCancelTicketJobAndRequeueResponse> {
  const actorId = requireActorId(auth);
  const { ticketJob, activeAssignments, ticketNos, activeBooths } =
    await performTicketJobCancellation(idParam, body, actorId);

  for (const booth of activeBooths) {
    await notifyVendorBoothCancelled({
      ticketId: booth.id,
      ticketNo: booth.ticketNo,
      marketName: booth.marketName,
      boothCode: booth.boothCode,
      boothName: booth.boothName,
      licensePlate: ticketJob.license_plate,
    });
  }

  const sortedAssignments =
    sortAssignmentsByAcceptedAt(activeAssignments);
  const candidateWorkerIds = sortedAssignments.map(
    (assignment) => assignment.worker_id,
  );

  // เช็คกะสดก่อนคืนเข้าคิวเสมอ — Worker ที่หมดกะไปแล้วต้องไป open_app ไม่ใช่ถูกดันกลับเข้า READY
  const { requeuedWorkerIds, openAppWorkerIds } =
    await requeueWorkersAtFrontRespectingShift(candidateWorkerIds);

  for (const workerId of requeuedWorkerIds) {
    sendWorkerSocketEvent(workerId, "WORKER_STATUS_CHANGED", {
      status: WORKER_WORK_STATUS.READY,
      reason: "vehicle_job_cancelled_requeue",
    });
  }
  for (const workerId of openAppWorkerIds) {
    sendWorkerSocketEvent(workerId, "WORKER_STATUS_CHANGED", {
      status: WORKER_WORK_STATUS.OPEN_APP,
      reason: "vehicle_job_cancelled_shift_ended",
    });
  }
  if (openAppWorkerIds.length > 0) {
    // แจ้ง Admin SSE ทีละคนสำหรับกลุ่มที่หมดกะไปแล้ว (ต่างจาก requeuedWorkerIds ที่กลับ ready ปกติ) —
    // publishRealtimeEvent ของ VEHICLE_JOB_CANCELLED ด้านล่างไม่มี per-worker queue snapshot ให้ตาราง
    // worker status ฝั่ง Admin dashboard refresh ได้
    const openAppWorkerCodeMap = await profileRepository.findWorkerCodeMapByAccountIds(
      openAppWorkerIds,
    );

    for (const workerId of openAppWorkerIds) {
      const workerCode = openAppWorkerCodeMap.get(workerId) ?? null;
      const queue = await getWorkerQueueStatus(workerId);

      publishAdminWorkerStatusChanged({
        title: "Worker moved to open_app",
        message: `Worker ${workerCode ?? workerId} moved to open_app after vehicle job cancellation because the shift already ended.`,
        workerCode,
        queue,
        reason: "vehicle_job_cancelled_shift_ended",
      });
    }
  }
  publishRealtimeEvent({
    type: "VEHICLE_JOB_CANCELLED",
    title: "Vehicle job cancelled",
    message: `Vehicle job ${ticketJob.ticket_number} was cancelled and workers were requeued.`,
    payload: {
      ticketNumber: ticketJob.ticket_number,
      status: ticketJob.status,
      requeued: true,
    },
    worker_payload: {
      ticketNumber: ticketJob.ticket_number,
      ticketNos,
      status: ticketJob.status,
      requeued: true,
      reason: "vehicle_job_cancelled_requeue",
    },
    worker_ids: requeuedWorkerIds,
  });
  if (requeuedWorkerIds.length > 0) {
    // dispatch เป็น best-effort ต้องไม่ทำให้ request cancel ที่สำเร็จแล้วพัง 500 เพราะ dispatch ล้มเหลว
    try {
      await dispatchReadyWorkers();
    } catch (error) {
      logger.error("Vehicle job assignment cancelled but worker dispatch failed.", {
        ticketJobId: ticketJob.id,
        error,
      });
    }
  }
  const [requeuedWorkerCodes, openAppWorkerCodes] = await Promise.all([
    profileRepository.findWorkerCodesByAccountIds(requeuedWorkerIds),
    profileRepository.findWorkerCodesByAccountIds(openAppWorkerIds),
  ]);

  publishNotification({
    type: "VEHICLE_JOB_CANCELLED_AND_REQUEUED",
    title: "Vehicle job cancelled and workers requeued",
    message: `Vehicle job ${ticketJob.ticket_number} was cancelled and workers were requeued.`,
    payload: {
      ticketNumber: ticketJob.ticket_number,
      status: ticketJob.status,
      worker_to_queue: requeuedWorkerCodes,
      worker_to_openapp: openAppWorkerCodes,
    },
    audience: {
      roles: ["admin"],
    },
  });

  return {
    message: "Vehicle job cancelled and workers requeued successfully.",
    ticket_number: ticketJob.ticket_number,
    status: ticketJob.status,
    worker_to_queue: requeuedWorkerCodes,
    worker_to_openapp: openAppWorkerCodes,
  };
}

// Function ยกเลิกรวม (vehicle/ticket_no/booth/worker) โดย scope ตัดสินจากว่า ticket_no/boothCode/
// worker_code ตัวไหนถูกระบุมาบ้าง (ดู mapping เต็มที่ adminTicketJobAssignmentCancelBodySchema)
export async function cancelTicketJobAssignment(
  body: unknown,
  auth?: AccessTokenPayload,
): Promise<AdminTicketJobAssignmentCancelResponse> {
  const input = parseWithSchema(adminTicketJobAssignmentCancelBodySchema, body);
  const cancelBody = { reason_code: input.reason_code, reason_text: input.reason_text };

  if (input.boothCode && !input.ticket_no) {
    throw new ApiError(
      400,
      "INVALID_CANCEL_SCOPE",
      "boothCode requires ticket_no to also be specified.",
    );
  }

  if (!input.ticket_no && !input.worker_code) {
    return cancelTicketJobAndRequeue(input.ticket_number, cancelBody, auth);
  }

  if (!input.ticket_no && input.worker_code) {
    return cancelAssignment(
      input.ticket_number,
      input.worker_code,
      cancelBody,
      auth,
    );
  }

  // จากตรงนี้ ticket_no มีค่าแน่นอนแล้ว (ผ่าน guard ด้านบนมาแล้ว)
  if (input.boothCode && input.worker_code) {
    return cancelTicketWorkerFromBooth(
      input.ticket_number,
      input.ticket_no,
      input.boothCode,
      input.worker_code,
      cancelBody,
      auth,
    );
  }

  if (input.boothCode) {
    return cancelStallJobByTicketContext(
      input.ticket_number,
      input.ticket_no,
      input.boothCode,
      cancelBody,
      auth,
    );
  }

  if (input.worker_code) {
    return cancelTicketWorker(
      input.ticket_number,
      input.ticket_no,
      input.worker_code,
      cancelBody,
      auth,
    );
  }

  return cancelMarketJobByTicketContext(
    input.ticket_number,
    input.ticket_no,
    cancelBody,
    auth,
  );
}

// Function จัดการ vehicle job workers ใน service flow
export async function assignTicketJobWorkers(
  idParam: unknown,
  body: unknown,
  auth?: AccessTokenPayload,
): Promise<AdminAssignWorkersResponse> {
  const existingTicketJob = await requireTicketJobByRef(idParam);
  const ticketJobId = existingTicketJob.id;
  const input = parseWithSchema(adminAssignWorkersBodySchema, body);
  const actorId = requireActorId(auth);
  const workerCodes = [...new Set(input.worker_codes)];
  const settings = await getRuntimeSettings();
  const acceptDeadlineMs = settings.worker_accept_deadline_seconds * 1000;

  const { assignments, ticketJob } = await withTransaction(
    async (transaction) => {
      const ticketJob = await requireTicketJobByRef(idParam, transaction);

      if (TERMINAL_JOB_STATUSES.includes(ticketJob.status)) {
        throw new ApiError(
          409,
          "VEHICLE_JOB_CLOSED",
          "Vehicle job is already closed.",
        );
      }

      const createdAssignments: TicketJobAssignmentDto[] = [];

      for (const workerCode of workerCodes) {
        const worker = await adminJobsRepository.findWorkerByCode(
          workerCode,
          transaction,
        );

        if (!worker) {
          throw new ApiError(
            404,
            "WORKER_NOT_FOUND",
            `Worker ${workerCode} not found.`,
          );
        }

        // ล็อกแถว MasterWorker ก่อนเช็ค Active Assignment เดิม กัน Race เมื่อสอง Request assign worker
        // คนเดียวกันพร้อมกัน (ไม่งั้นทั้งสอง transaction จะเห็นว่ายังไม่มี assignment แล้วสร้างซ้อนกันได้)
        await transaction.$queryRaw`SELECT id FROM master_workers WHERE id = ${worker.id} FOR UPDATE`;

        const currentAssignment =
          await assignmentRepository.findCurrentAssignmentByWorker(
            worker.id,
            transaction,
          );

        if (worker.status !== MASTER_WORKER_STATUS.ACTIVE) {
          throw new ApiError(
            403,
            "WORKER_NOT_ACTIVE",
            `Worker ${workerCode} is not active.`,
          );
        }

        if (currentAssignment) {
          throw new ApiError(
            409,
            "WORKER_HAS_ACTIVE_ASSIGNMENT",
            `Worker ${workerCode} already has an active assignment.`,
          );
        }

        const queueEntry = await getWorkerQueueStatus(worker.id);

        if (queueEntry?.status !== WORKER_WORK_STATUS.READY) {
          throw new ApiError(
            409,
            "WORKER_NOT_READY",
            `Worker ${workerCode} must be ready in queue before admin can assign a job.`,
          );
        }

        // ห้ามมอบหมายงานให้ worker ที่อยู่นอกเวลากะเด็ดขาด แม้สถานะคิวจะเป็น READY อยู่ก็ตาม (เผื่อ
        // หลุดมาจากช่องทางอื่น) เช็คเวลาสดจาก DB อีกชั้นก่อน assign จริงเสมอ
        const workerSchedule = await workScheduleRepository.findCurrentByAccountId(
          worker.id,
          transaction,
        );

        if (!workerSchedule || !isTimeInWorkSchedule(workerSchedule)) {
          throw new ApiError(
            403,
            "WORKER_OUTSIDE_WORK_SHIFT",
            `Worker ${workerCode} is outside their work shift and cannot be assigned a job.`,
          );
        }

        const assignment = await assignmentRepository.createAssignment(
          ticketJobId,
          worker.id,
          buildDeadline(acceptDeadlineMs),
          transaction,
        );

        createdAssignments.push(assignment);
      }

      await adminActionLogRepository.create(
        {
          vehicle_job_id: ticketJobId,
          action_type: ADMIN_ACTION_TYPE.MANUAL_ASSIGNMENT,
          reason_code: input.reason_code,
          reason_text: input.reason_text ?? null,
          actor_account_id: actorId,
          metadata: {
            source: "manual_assign",
            assignment_ids: createdAssignments.map(
              (assignment) => assignment.id,
            ),
            worker_ids: createdAssignments.map(
              (assignment) => assignment.worker_id,
            ),
            worker_codes: workerCodes,
          },
        },
        transaction,
      );

      return {
        assignments: createdAssignments,
        ticketJob,
      };
    },
  );

  // Assignment ทุกตัว commit ลง DB แล้วจริง จากนี้เป็นแค่ best-effort notify Redis/BullMQ/Socket
  // ต้องครอบ try/catch แยกทีละ worker ห้าม throw ออก ไม่งั้น worker ที่เหลือจะไม่ได้ schedule timeout ค้างถาวร และ request จะพัง 500 ทั้งที่ assign สำเร็จแล้ว
  let tickets: Array<{ ticket_no: string; created_at: string }> = [];

  try {
    tickets = await marketJobRepository.listActiveTicketSummariesByTicketJobId(
      ticketJob.id,
    );
  } catch (error) {
    logger.error("Failed to load active ticket numbers after manual worker assignment.", {
      ticketJobId: ticketJob.id,
      error,
    });
  }

  for (const assignment of assignments) {
    try {
      await markWorkerAssigned(assignment.worker_id);
      await scheduleAssignmentTimeout(
        assignment.id,
        assignment.worker_id,
        acceptDeadlineMs,
      );
      sendWorkerSocketEvent(
        assignment.worker_id,
        "WORKER_ASSIGNED",
        buildWorkerAssignedPayload(assignment, ticketJob, tickets),
      );
    } catch (error) {
      logger.error("Failed to notify worker after manual assignment was already committed.", {
        ticketJobId: ticketJob.id,
        workerId: assignment.worker_id,
        assignmentId: assignment.id,
        error,
      });
    }
  }
  const assignmentResponses = await buildAdminAssignmentResponses(
    ticketJob.ticket_number,
    assignments,
  );

  publishNotification({
    type: "ASSIGNMENT_CREATED_BY_ADMIN",
    title: "Workers assigned by admin",
    message: `${assignments.length} worker(s) were assigned to vehicle job ${ticketJob.ticket_number}.`,
    payload: {
      ticketNumber: ticketJob.ticket_number,
      worker_codes: workerCodes,
      assignments: assignmentResponses,
    },
    audience: {
      roles: ["admin"],
    },
  });

  return {
    message: "Workers assigned successfully.",
    ticket_number: ticketJob.ticket_number,
    assignments: assignmentResponses,
  };
}

// Function ยกเลิก assignment ใน service flow
async function cancelAssignment(
  idParam: unknown,
  workerCodeParam: unknown,
  body: unknown,
  auth?: AccessTokenPayload,
): Promise<AdminCancelAssignmentResponse> {
  const ticketNumber = parseReference(
    idParam,
    "INVALID_VEHICLE_JOB_REF",
    "TicketNumber is invalid.",
  );
  const workerCode = parseReference(
    workerCodeParam,
    "INVALID_WORKER_CODE",
    "Worker code is invalid.",
  );
  const input = parseWithSchema(adminCancelAssignmentBodySchema, body ?? {});
  const actorId = requireActorId(auth);
  const assignment =
    await adminJobsRepository.findActiveAssignmentByTicketJobRefAndWorkerCode(
      ticketNumber,
      workerCode,
    );

  if (!assignment) {
    throw new ApiError(404, "ASSIGNMENT_NOT_FOUND", "Assignment not found.");
  }

  if (!ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status)) {
    throw new ApiError(
      409,
      "ASSIGNMENT_NOT_ACTIVE",
      "Assignment is not active.",
    );
  }

  const ticketJob = await ticketJobRepository.findTicketJobById(
    assignment.vehicle_job_id,
  );
  const { cancelledAssignment, teamScan } = await withTransaction(async (transaction) =>
    {
      const result = await assignmentRepository.cancelAssignment(
        assignment.id,
        transaction,
      );

      if (!result) {
        // แพ้ race ให้ worker accept/scan/timeout เปลี่ยนสถานะไปก่อนระหว่างเช็ค active กับตอนเขียนจริง
        // throw ที่นี่เพื่อ rollback transaction แทนที่จะเขียน AdminActionLog/แตะ roster ทั้งที่ยกเลิกไม่ได้เกิดขึ้นจริง
        throw new ApiError(
          409,
          "ASSIGNMENT_NOT_ACTIVE",
          "Assignment is not active.",
        );
      }

      const teamScan =
        await assignmentRepository.getTicketJobTeamScanReadiness(
          assignment.vehicle_job_id,
          transaction,
        );

      if (teamScan.is_ready) {
        await ticketJobLifecycleService.markTicketJobInProgress(
          assignment.vehicle_job_id,
          transaction,
        );
      }

      await adminActionLogRepository.create(
        {
          vehicle_job_id: assignment.vehicle_job_id,
          action_type: ADMIN_ACTION_TYPE.ASSIGNMENT_CANCELLED,
          reason_code: input.reason_code ?? null,
          reason_text: input.reason_text ?? null,
          actor_account_id: actorId,
          metadata: {
            assignment_id: assignment.id,
            worker_id: assignment.worker_id,
            worker_code: workerCode,
          },
        },
        transaction,
      );

      return { cancelledAssignment: result, teamScan };
    },
  );

  await removeAssignmentTimeout(assignment.id);
  await removeScanTimeout(assignment.id);
  await removeScanWarning(assignment.id);
  const queue = await markWorkerOpenApp(assignment.worker_id);
  const ticketNos = await marketJobRepository.listActiveTicketNosByTicketJobId(
    assignment.vehicle_job_id,
  );

  sendWorkerSocketEvent(assignment.worker_id, "ASSIGNMENT_CANCELLED", {
    ticketNumber: ticketJob?.ticket_number ?? null,
    ticketNos,
    reason: "admin_cancel_assignment",
  });
  // แจ้ง Admin SSE แยกจาก ASSIGNMENT_CANCELLED ด้านบน (event นั้นไม่มี queue snapshot ของ worker) —
  // ให้ตาราง worker status ฝั่ง Admin dashboard refresh ทันทีแบบเดียวกับจุดอื่นที่ worker กลับไป open_app
  publishAdminWorkerStatusChanged({
    title: "Worker moved to open_app",
    message: `Worker ${workerCode} moved to open_app after admin cancelled the assignment.`,
    workerCode,
    queue,
    reason: "admin_cancel_assignment",
  });

  // แจ้งทีมที่เหลือถ้าการยกเลิกคนนี้ทำให้ workers_required ลดลงจนทีมที่เหลือ scan ครบพอดี
  // ไม่งั้นทีมจะไม่รู้ตัวว่าเริ่มงานได้แล้วจนกว่าจะ reconnect socket หรือ refresh เอง
  if (ticketJob) {
    await notifyTicketJobTeamScanReadiness(ticketJob, teamScan);
  }
  publishNotification({
    type: "ASSIGNMENT_CANCELLED",
    title: "Assignment cancelled",
    message: `Assignment for ${workerCode} on ${ticketJob?.ticket_number ?? ticketNumber} was cancelled by admin.`,
    payload: {
      ticketNumber: ticketJob?.ticket_number ?? ticketNumber,
      worker_code: workerCode,
      status: cancelledAssignment.status,
      reason: "admin_cancel_assignment",
    },
    audience: {
      roles: ["admin"],
    },
  });

  return {
    message: "Assignment cancelled successfully.",
    ticket_number: ticketJob?.ticket_number ?? ticketNumber,
    worker_code: workerCode,
    status: cancelledAssignment.status,
  };
}

// Function ต่อเวลา vehicle job scan deadline ใน service flow
export async function extendTicketJobScanDeadline(
  idParam: unknown,
  body: unknown,
  auth?: AccessTokenPayload,
): Promise<AdminExtendScanDeadlineResponse> {
  const ticketJob = await requireTicketJobByRef(idParam);
  const ticketJobId = ticketJob.id;
  const input = parseWithSchema(adminExtendScanDeadlineBodySchema, body);
  const actorId = requireActorId(auth);

  const assignments = (
    await assignmentRepository.listAcceptedAssignmentsByTicketJob(
      ticketJobId,
      { workerCodes: input.worker_codes },
    )
  ).filter((assignment) => isScanDeadlineActive(assignment.scan_deadline_at));

  if (assignments.length === 0) {
    throw new ApiError(
      404,
      "ACCEPTED_ASSIGNMENTS_NOT_FOUND",
      "No active accepted assignments found for scan deadline extension.",
    );
  }

  const updatedAssignments = await withTransaction(async (transaction) => {
    const results: TicketJobAssignmentDto[] = [];

    for (const assignment of assignments) {
      const extended = await assignmentRepository.extendAssignmentScanDeadline(
        assignment.id,
        extendDeadline(assignment.scan_deadline_at, input.minutes),
        transaction,
      );

      // แพ้ race ให้ scan-timeout job หรือ worker scan สำเร็จไปพร้อมกัน ข้ามไปเฉยๆ ไม่ทำให้ทั้ง batch ล้มเหลว
      // ให้ worker คนอื่นที่ยังต่อเวลาได้ทำต่อไปตามปกติ
      if (extended) {
        results.push(extended);
      }
    }

    await adminActionLogRepository.create(
      {
        vehicle_job_id: ticketJobId,
        action_type: ADMIN_ACTION_TYPE.SCAN_DEADLINE_EXTENDED,
        reason_code: input.reason_code ?? null,
        reason_text: input.reason_text ?? null,
        actor_account_id: actorId,
        metadata: {
          minutes: input.minutes,
          assignment_ids: results.map((assignment) => assignment.id),
          worker_ids: results.map(
            (assignment) => assignment.worker_id,
          ),
        },
      },
      transaction,
    );

    return results;
  });
  await Promise.all(
    updatedAssignments.flatMap((assignment) => [
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
  const assignmentResponses =
    await buildScanDeadlineAssignmentResponses(updatedAssignments);
  const ticketNos = await marketJobRepository.listActiveTicketNosByTicketJobId(
    ticketJobId,
  );

  publishRealtimeEvent({
    type: "ASSIGNMENT_SCAN_DEADLINE_EXTENDED",
    title: "Scan deadline extended",
    message: `Scan deadline was extended for ${updatedAssignments.length} assignment(s).`,
    payload: {
      ticketNumber: ticketJob.ticket_number,
      minutes: input.minutes,
      worker_codes: input.worker_codes ?? null,
      assignments: assignmentResponses,
    },
    worker_payload: {
      ticketNumber: ticketJob.ticket_number,
      ticketNos,
      minutes: input.minutes,
      assignments: assignmentResponses,
    },
    admin: true,
    worker_ids: updatedAssignments.map(
      (assignment) => assignment.worker_id,
    ),
  });

  return {
    message: "Vehicle job scan deadline extended successfully.",
    ticket_number: ticketJob.ticket_number,
    assignments: assignmentResponses,
  };
}

// Function จัดการ side effect เมื่อ TicketJob ปิดเป็น terminal จากผลพวงการยกเลิกตลาด/booth (ไม่ใช่ยกเลิกทั้งรถตรงๆ)
// เคลียร์ timer แล้วคืน worker เข้าคิว เรียกได้ปลอดภัยแม้ result เป็น null เพราะ closeCompletedTicketJobIfReady คืนค่า non-null แค่ครั้งเดียวเท่านั้น
async function handleTicketJobClosedByCascadeCancellation(
  result: CompletedTicketJobResult | null,
): Promise<void> {
  if (!result) {
    return;
  }

  await Promise.all(
    result.completed_assignment_ids.flatMap((assignmentId) => [
      removeAssignmentTimeout(assignmentId),
      removeScanTimeout(assignmentId),
      removeScanWarning(assignmentId),
    ]),
  );

  await returnCompletedWorkersToQueue(result);

  publishRealtimeEvent({
    type: "VEHICLE_JOB_CLOSED",
    title: "Vehicle job closed",
    message: `Vehicle job ${result.vehicle_job.ticket_number} closed as ${result.vehicle_job.status} after a market/booth cancellation.`,
    payload: {
      ticketNumber: result.vehicle_job.ticket_number,
      status: result.vehicle_job.status,
    },
    worker_payload: {
      ticketNumber: result.vehicle_job.ticket_number,
      status: result.vehicle_job.status,
    },
    admin: true,
    worker_ids: result.completed_worker_ids,
  });
}

// Function ยกเลิก market job ระบุบริบทผ่าน TicketNumber (TicketJob) + TicketNo (Business Ticket)
// ตรงๆ ไม่กำกวมข้ามรถ/ข้าม Business Ticket เหมือน target_ref=marketCode เดี่ยวๆ
async function cancelMarketJobByTicketContext(
  ticketNumberParam: unknown,
  ticketNoParam: unknown,
  body: unknown,
  auth?: AccessTokenPayload,
): Promise<AdminMarketJobActionResponse> {
  const ticketJob = await requireTicketJobByRef(ticketNumberParam);
  const ticketNo = parseReference(
    ticketNoParam,
    "INVALID_TICKET_NO",
    "TicketNo is invalid.",
  );
  const input = parseWithSchema(adminCancelBodySchema, body ?? {});
  const actorId = requireActorId(auth);

  const marketJob = await marketJobRepository.findMarketJobByVehicleAndTicketNo(
    ticketJob.id,
    ticketNo,
  );

  if (!marketJob) {
    throw new ApiError(
      404,
      "MARKET_JOB_NOT_FOUND",
      "Business ticket not found.",
    );
  }

  return cancelMarketJobById(
    marketJob.id,
    input.reason_code ?? null,
    input.reason_text ?? null,
    actorId,
  );
}

// Function หลักที่ยกเลิก market job จริง — ล็อกแถวและเช็คว่ายังไม่ terminal ก่อนเขียนทับเสมอ กัน
// race ที่อีก request ยกเลิก/ปิดงานใบเดียวกันพร้อมกัน
async function cancelMarketJobById(
  marketJobId: number,
  reasonCode: string | null,
  reasonText: string | null,
  actorId: number,
): Promise<AdminMarketJobActionResponse> {
  const { marketJob, completedTicketJob, activeBooths } = await withTransaction(async (transaction) => {
    await transaction.$queryRaw`SELECT id FROM market_jobs WHERE id = ${marketJobId} FOR UPDATE`;

    const current = await marketJobRepository.findMarketJobById(
      marketJobId,
      transaction,
    );

    if (!current) {
      throw new ApiError(
        404,
        "MARKET_JOB_NOT_FOUND",
        "Business ticket not found.",
      );
    }

    if (TERMINAL_JOB_STATUSES.includes(current.status)) {
      throw new ApiError(
        409,
        "MARKET_JOB_ALREADY_CLOSED",
        "Business ticket is already completed or cancelled.",
      );
    }

    // ห้ามยกเลิกทั้ง Business Ticket ถ้ามี Booth ไหนเคยถูกส่งยอดมาแล้ว ไม่ว่าผลจะเป็น DELIVERED
    // (รอ Vendor) หรือ REJECT (โดนปฏิเสธ) ก็ตาม — ต้องให้ส่งยอดใหม่จน Vendor ยืนยัน/timeout แทน
    const hasSubmittedTickets =
      await boothJobRepository.hasSubmittedActiveTicketsForMarketJob(
        marketJobId,
        transaction,
      );

    if (hasSubmittedTickets) {
      throw new ApiError(
        409,
        "MARKET_JOB_ALREADY_SUBMITTED",
        "Business ticket cannot be cancelled after a booth has already been submitted.",
      );
    }

    // ต้องดึงก่อน cancelMarketJob เท่านั้น เพราะ cascade จะทำให้ทุกแผงใต้ Business Ticket นี้กลายเป็น CANCELLED ไปด้วย — ใช้แจ้ง LINE แผงหลัง commit
    const activeBooths = await boothJobRepository.listActiveBoothsByMarketJobId(
      marketJobId,
      transaction,
    );

    const cancelled = await ticketJobLifecycleService.cancelMarketJob(marketJobId, transaction);

    // Audit log สำหรับ actor/reason ของการยกเลิก TicketNo นี้ — ใช้เป็น source ของ
    // Daily Worker Income Cancellation.CancelledByType/CancelledByName และ riskText
    await adminActionLogRepository.create(
      {
        vehicle_job_id: cancelled.vehicle_job_id,
        market_job_id: cancelled.id,
        action_type: ADMIN_ACTION_TYPE.MARKET_JOB_CANCELLED,
        reason_code: reasonCode,
        reason_text: reasonText,
        actor_account_id: actorId,
      },
      transaction,
    );

    // Roll up สถานะ MarketJob/TicketJob ในทรานแซกชันเดียวกัน ใช้ centralized lifecycle เดียวกับ vendor confirm/auto-confirm แทนการมีกฎแยกของตัวเอง
    const completedTicketJob =
      await ticketJobLifecycleService.closeCompletedTicketJobIfReady(
        cancelled.vehicle_job_id,
        transaction,
      );

    return { marketJob: cancelled, completedTicketJob, activeBooths };
  });
  const ticketJob = await ticketJobRepository.findTicketJobById(
    marketJob.vehicle_job_id,
  );
  publishRealtimeEvent({
    type: "MARKET_JOB_CANCELLED",
    title: "Market job cancelled",
    message: `Market job ${marketJob.marketCode} was cancelled.`,
    payload: {
      ticketNumber: ticketJob?.ticket_number ?? null,
      marketCode: marketJob.marketCode,
      status: marketJob.status,
    },
    worker_payload: {
      ticketNumber: ticketJob?.ticket_number ?? null,
      ticketNos: [marketJob.ticket_no],
      marketCode: marketJob.marketCode,
      status: marketJob.status,
    },
    admin: true,
    worker_ids: await listTicketJobWorkerIds(marketJob.vehicle_job_id),
  });

  for (const booth of activeBooths) {
    await notifyVendorBoothCancelled({
      ticketId: booth.id,
      ticketNo: marketJob.ticket_no,
      marketName: marketJob.marketName,
      boothCode: booth.boothCode,
      boothName: booth.boothName,
      licensePlate: ticketJob?.license_plate ?? "",
    });
  }

  await handleTicketJobClosedByCascadeCancellation(completedTicketJob);

  return formatMarketJobActionResponse(
    "Market job cancelled successfully.",
    marketJob,
    ticketJob,
  );
}

// Function ยกเลิก stall job ระบุบริบทผ่าน TicketNumber + TicketNo (Business Ticket) + StallCode
// ตรงๆ ไม่กำกวมข้าม Business Ticket เหมือน target_ref=boothCode เดี่ยวๆ
async function cancelStallJobByTicketContext(
  ticketNumberParam: unknown,
  ticketNoParam: unknown,
  stallCodeParam: unknown,
  body: unknown,
  auth?: AccessTokenPayload,
): Promise<AdminStallJobActionResponse> {
  const ticketJob = await requireTicketJobByRef(ticketNumberParam);
  const ticketNo = parseReference(
    ticketNoParam,
    "INVALID_TICKET_NO",
    "TicketNo is invalid.",
  );
  const stallCode = parseReference(
    stallCodeParam,
    "INVALID_BOOTH_CODE",
    "BoothCode is invalid.",
  );
  const input = parseWithSchema(adminCancelBodySchema, body ?? {});
  const actorId = requireActorId(auth);

  const ticket =
    await boothJobRepository.findBoothJobForCompletionByTicketNumberAndTicketNoAndBoothCode(
      ticketJob.ticket_number,
      ticketNo,
      stallCode,
    );

  if (!ticket) {
    throw new ApiError(404, "STALL_JOB_NOT_FOUND", "Stall job not found.");
  }

  return cancelStallJobById(
    ticket.id,
    input.reason_code ?? null,
    input.reason_text ?? null,
    actorId,
  );
}

// Function ตรวจว่า Booth นี้ยังไม่เคยถูกส่งยอด (DELIVERED/REJECT) — ใช้ร่วมกันโดย flow ที่ห้ามแตะ
// Booth หลังส่งยอดไปแล้ว ไม่ว่าจะยกเลิกทั้ง Booth หรือถอด worker ออกจาก Booth นั้น
function assertTicketNotSubmitted(status: string, message: string): void {
  if (status === TICKET_STATUS.DELIVERED || status === TICKET_STATUS.REJECT) {
    throw new ApiError(409, "STALL_JOB_ALREADY_SUBMITTED", message);
  }
}

// Function เขียนสถานะ CANCELLED ของ Booth หนึ่งใบ + Audit Log + Roll up สถานะ MarketJob/TicketJob
// ใช้ร่วมกันระหว่าง cancelStallJobById และ cancelTicketWorkerFromBooth ต้องรับ transaction จาก caller เสมอ ห้ามเปิดใหม่ เพราะ caller ล็อกแถว gate_tickets ไว้แล้ว เปิดซ้อนจะ deadlock
async function cancelStallJobRecord(
  ticket: BoothJobDto,
  reasonCode: string | null,
  reasonText: string | null,
  actorId: number,
  transaction: DbConnection,
  extraMetadata?: Record<string, unknown>,
): Promise<{
  ticket: BoothJobDto;
  completedTicketJob: CompletedTicketJobResult | null;
}> {
  const cancelled = await ticketJobLifecycleService.cancelBoothJob(ticket.id, transaction);

  await adminActionLogRepository.create(
    {
      vehicle_job_id: cancelled.vehicle_job_id,
      gate_ticket_id: cancelled.id,
      market_job_id: cancelled.market_job_id,
      action_type: ADMIN_ACTION_TYPE.STALL_JOB_CANCELLED,
      reason_code: reasonCode,
      reason_text: reasonText,
      actor_account_id: actorId,
      metadata: extraMetadata ?? null,
    },
    transaction,
  );

  // Roll up สถานะ MarketJob/TicketJob ในทรานแซกชันเดียวกัน ใช้ centralized lifecycle เดียวกับ vendor confirm/auto-confirm
  // ครอบคลุมทั้งกรณี Booth สุดท้ายของตลาด CANCELLED และกรณีตลาดมี Booth อื่น COMPLETED อยู่แล้ว (finalize financial snapshot)
  const completedTicketJob =
    await ticketJobLifecycleService.closeCompletedTicketJobIfReady(
      cancelled.vehicle_job_id,
      transaction,
    );

  return { ticket: cancelled, completedTicketJob };
}

// Function หลักที่ยกเลิก stall job จริง — ล็อกแถวและเช็คว่ายังไม่ terminal ก่อนเขียนทับเสมอ กัน
// race ที่อีก request ยกเลิก/ปิด booth เดียวกันพร้อมกัน
async function cancelStallJobById(
  ticketId: number,
  reasonCode: string | null,
  reasonText: string | null,
  actorId: number,
): Promise<AdminStallJobActionResponse> {
  const { ticket, completedTicketJob } = await withTransaction(async (transaction) => {
    await transaction.$queryRaw`SELECT id FROM booth_jobs WHERE id = ${ticketId} FOR UPDATE`;

    const current = await boothJobRepository.findBoothJobForCompletion(
      ticketId,
      transaction,
    );

    if (!current) {
      throw new ApiError(404, "STALL_JOB_NOT_FOUND", "Stall job not found.");
    }

    if (TERMINAL_TICKET_STATUSES.includes(current.status)) {
      throw new ApiError(
        409,
        "STALL_JOB_ALREADY_CLOSED",
        "Stall job is already completed or cancelled.",
      );
    }

    // ห้ามยกเลิก Booth ที่เคยถูกส่งยอดมาแล้ว ไม่ว่าผลจะเป็น DELIVERED (รอ Vendor) หรือ REJECT
    // (โดนปฏิเสธ) ก็ตาม — ต้องให้ส่งยอดใหม่จน Vendor ยืนยัน/timeout แทน
    assertTicketNotSubmitted(
      current.status,
      "Stall job cannot be cancelled after it has already been submitted.",
    );

    return cancelStallJobRecord(current, reasonCode, reasonText, actorId, transaction);
  });
  const ticketJob = await ticketJobRepository.findTicketJobById(
    ticket.vehicle_job_id,
  );
  const marketJob = await marketJobRepository.findMarketJobById(
    ticket.market_job_id,
  );
  publishRealtimeEvent({
    type: "STALL_JOB_CANCELLED",
    title: "Stall job cancelled",
    message: `Stall job ${ticket.boothCode} was cancelled.`,
    payload: {
      ticketNumber: ticketJob?.ticket_number ?? null,
      marketCode: marketJob?.marketCode ?? null,
      boothCode: ticket.boothCode,
      status: ticket.status,
      confirmation_status: ticket.confirmation_status,
    },
    worker_payload: {
      ticketNumber: ticketJob?.ticket_number ?? null,
      ticketNos: marketJob ? [marketJob.ticket_no] : [],
      marketCode: marketJob?.marketCode ?? null,
      boothCode: ticket.boothCode,
      status: ticket.status,
      confirmation_status: ticket.confirmation_status,
    },
    admin: true,
    worker_ids: await listStallJobWorkerIds(ticket),
  });

  await notifyVendorBoothCancelled({
    ticketId: ticket.id,
    ticketNo: marketJob?.ticket_no ?? "",
    marketName: marketJob?.marketName ?? "",
    boothCode: ticket.boothCode,
    boothName: ticket.boothName,
    licensePlate: ticketJob?.license_plate ?? "",
  });

  await handleTicketJobClosedByCascadeCancellation(completedTicketJob);

  return formatStallJobActionResponse(
    "Stall job cancelled successfully.",
    ticket,
    ticketJob,
    marketJob,
  );
}

// Function ยกเลิก Worker หนึ่งคนออกจาก Business Ticket ใบเดียว ต่างจาก cancelAssignment ที่ cascade
// ไปทุก Business Ticket ของรถ — ฟังก์ชันนี้ไม่แตะ TicketJobAssignment กระทบแค่ Roster ของ Ticket นี้ใบเดียว
async function cancelTicketWorker(
  ticketNumberParam: unknown,
  ticketNoParam: unknown,
  workerCodeParam: unknown,
  body: unknown,
  auth?: AccessTokenPayload,
): Promise<AdminCancelTicketWorkerResponse> {
  const ticketJob = await requireTicketJobByRef(ticketNumberParam);
  const ticketNo = parseReference(
    ticketNoParam,
    "INVALID_TICKET_NO",
    "TicketNo is invalid.",
  );
  const workerCode = parseReference(
    workerCodeParam,
    "INVALID_WORKER_CODE",
    "Worker code is invalid.",
  );
  const input = parseWithSchema(adminCancelBodySchema, body ?? {});
  const actorId = requireActorId(auth);

  const marketJob = await marketJobRepository.findMarketJobByVehicleAndTicketNo(
    ticketJob.id,
    ticketNo,
  );

  if (!marketJob) {
    throw new ApiError(
      404,
      "MARKET_JOB_NOT_FOUND",
      "Business ticket not found.",
    );
  }

  const worker = await adminJobsRepository.findWorkerByCode(workerCode);

  if (!worker) {
    throw new ApiError(404, "WORKER_NOT_FOUND", `Worker ${workerCode} not found.`);
  }

  const cancelled = await withTransaction(async (transaction) => {
    // Lock แถว Business Ticket ก่อนเช็ค guard กัน race กับ worker ที่เพิ่งส่งยอดแผงในใบนี้พร้อมกันคนละ transaction
    await transaction.$queryRaw`SELECT id FROM market_jobs WHERE id = ${marketJob.id} FOR UPDATE`;

    // ห้ามถอด worker ออกจาก roster ทั้ง Business Ticket ถ้ามีแผงไหนใต้ใบนี้เคยถูกส่งยอดมาแล้ว ไม่ว่าผลจะเป็น
    // DELIVERED (รอ Vendor) หรือ REJECT (โดนปฏิเสธ) ก็ตาม — เพราะ worker snapshot ที่ใช้หารเงินจริงถูกบันทึก
    // ตอน Vendor confirm (อ่าน TicketWorker.status สดตอนนั้น) ไม่ใช่ตอนส่งยอด ถอด worker ออกตอนนี้จะทำให้เขา
    // หลุดจากตัวหารเงินไปเงียบๆ ทั้งที่ทำงานแผงนี้จริง — guard เดียวกับ cancelTicketWorkerFromBooth
    const hasSubmittedTickets =
      await boothJobRepository.hasSubmittedActiveTicketsForMarketJob(
        marketJob.id,
        transaction,
      );

    if (hasSubmittedTickets) {
      throw new ApiError(
        409,
        "MARKET_JOB_ALREADY_SUBMITTED",
        "Worker cannot be removed from this business ticket after a booth has already been submitted.",
      );
    }

    const result = await ticketJobLifecycleService.cancelTicketWorkerForMarketJob(
      marketJob.id,
      worker.id,
      transaction,
    );

    if (!result) {
      return result;
    }

    await adminActionLogRepository.create(
      {
        vehicle_job_id: ticketJob.id,
        market_job_id: marketJob.id,
        action_type: ADMIN_ACTION_TYPE.TICKET_WORKER_CANCELLED,
        reason_code: input.reason_code ?? null,
        reason_text: input.reason_text ?? null,
        actor_account_id: actorId,
        metadata: {
          worker_id: worker.id,
          worker_code: workerCode,
        },
      },
      transaction,
    );

    return result;
  });

  if (!cancelled) {
    throw new ApiError(
      404,
      "TICKET_WORKER_NOT_FOUND",
      "Worker is not an active member of this business ticket.",
    );
  }

  publishNotification({
    type: "TICKET_WORKER_CANCELLED",
    title: "Worker removed from business ticket",
    message: `Worker ${workerCode} was removed from ticket ${ticketNo} by admin.`,
    payload: {
      ticketNumber: ticketJob.ticket_number,
      ticketNo,
      worker_code: workerCode,
      status: TICKET_WORKER_STATUS.CANCELLED,
    },
    audience: {
      roles: ["admin"],
    },
  });

  return {
    message: "Worker removed from business ticket successfully.",
    ticket_number: ticketJob.ticket_number,
    ticket_no: ticketNo,
    worker_code: workerCode,
    status: TICKET_WORKER_STATUS.CANCELLED,
  };
}

// Function ถอด Worker ออกจากแค่ Booth เดียว (ไม่แตะ TicketWorker.status worker ยังทำ Booth อื่นในใบเดียวกันต่อได้)
// ล็อกแถว Booth และเช็คว่ายังไม่เคยส่งยอดก่อนสร้าง BoothJobWorkerExclusion กัน race กับ request อื่นที่ยกเลิก/ส่งยอด Booth เดียวกัน
async function cancelTicketWorkerFromBooth(
  ticketNumberParam: unknown,
  ticketNoParam: unknown,
  boothCodeParam: unknown,
  workerCodeParam: unknown,
  body: unknown,
  auth?: AccessTokenPayload,
): Promise<AdminCancelTicketWorkerFromBoothResponse> {
  const ticketJob = await requireTicketJobByRef(ticketNumberParam);
  const ticketNo = parseReference(
    ticketNoParam,
    "INVALID_TICKET_NO",
    "TicketNo is invalid.",
  );
  const boothCode = parseReference(
    boothCodeParam,
    "INVALID_BOOTH_CODE",
    "BoothCode is invalid.",
  );
  const workerCode = parseReference(
    workerCodeParam,
    "INVALID_WORKER_CODE",
    "Worker code is invalid.",
  );
  const input = parseWithSchema(adminCancelBodySchema, body ?? {});
  const actorId = requireActorId(auth);

  const ticket =
    await boothJobRepository.findBoothJobForCompletionByTicketNumberAndTicketNoAndBoothCode(
      ticketJob.ticket_number,
      ticketNo,
      boothCode,
    );

  if (!ticket) {
    throw new ApiError(404, "STALL_JOB_NOT_FOUND", "Stall job not found.");
  }

  const worker = await adminJobsRepository.findWorkerByCode(workerCode);

  if (!worker) {
    throw new ApiError(404, "WORKER_NOT_FOUND", `Worker ${workerCode} not found.`);
  }

  const { boothCancelled, completedTicketJob } = await withTransaction(async (transaction) => {
    await transaction.$queryRaw`SELECT id FROM booth_jobs WHERE id = ${ticket.id} FOR UPDATE`;

    const current = await boothJobRepository.findBoothJobForCompletion(
      ticket.id,
      transaction,
    );

    if (!current) {
      throw new ApiError(404, "STALL_JOB_NOT_FOUND", "Stall job not found.");
    }

    if (TERMINAL_TICKET_STATUSES.includes(current.status)) {
      throw new ApiError(
        409,
        "STALL_JOB_ALREADY_CLOSED",
        "Stall job is already completed or cancelled.",
      );
    }

    // ห้ามถอด worker ออกจาก Booth ที่เคยถูกส่งยอดมาแล้ว ไม่ว่าผลจะเป็น DELIVERED (รอ Vendor) หรือ
    // REJECT (โดนปฏิเสธ) ก็ตาม — เหมือน guard ของการยกเลิกทั้ง Booth ทุกประการ
    assertTicketNotSubmitted(
      current.status,
      "Worker cannot be removed from this booth after it has already been submitted.",
    );

    // ดึงและเช็คสถานะ TicketWorker หลังได้ row lock แล้วเท่านั้น กัน TOCTOU ที่ worker อาจถูกยกเลิกออกจาก
    // Business Ticket หรือ Booth นี้ไปแล้วพอดีระหว่างที่ request นี้เพิ่งอ่านค่าไปก่อนได้ lock
    const ticketWorker =
      await ticketWorkerRepository.findTicketWorkerByMarketJobAndWorkerAccountId(
        ticket.market_job_id,
        worker.id,
        transaction,
      );

    if (!ticketWorker || ticketWorker.status !== TICKET_WORKER_STATUS.WORKING) {
      throw new ApiError(
        404,
        "TICKET_WORKER_NOT_FOUND",
        "Worker is not an active member of this business ticket.",
      );
    }

    const alreadyExcluded = await boothJobRepository.findBoothJobWorkerExclusion(
      ticket.id,
      ticketWorker.id,
      transaction,
    );

    if (alreadyExcluded) {
      throw new ApiError(
        409,
        "WORKER_ALREADY_EXCLUDED_FROM_BOOTH",
        "Worker is already excluded from this booth.",
      );
    }

    await boothJobRepository.createBoothJobWorkerExclusion(
      ticket.id,
      ticketWorker.id,
      transaction,
    );

    await adminActionLogRepository.create(
      {
        vehicle_job_id: ticketJob.id,
        gate_ticket_id: ticket.id,
        market_job_id: ticket.market_job_id,
        action_type: ADMIN_ACTION_TYPE.TICKET_WORKER_CANCELLED_FROM_BOOTH,
        reason_code: input.reason_code ?? null,
        reason_text: input.reason_text ?? null,
        actor_account_id: actorId,
        metadata: {
          worker_id: worker.id,
          worker_code: workerCode,
        },
      },
      transaction,
    );

    // เช็คหลังสร้าง Exclusion และหลังได้ row lock แล้วเท่านั้น กัน race ระหว่างสอง request ที่ exclude
    // worker คนละคนของ Booth เดียวกันพร้อมกัน — ถ้าไม่เหลือ worker ที่ยัง WORKING เลยต้องยกเลิกทั้ง Booth ไปด้วย ไม่ปล่อยให้ confirmTicketCompletion เจอ snapshot ว่างแล้วจ่ายเงินผิดคนทีหลัง
    const remainingEligibleWorkers = await boothJobRepository.countEligibleWorkersForBooth(
      ticket.market_job_id,
      ticket.id,
      transaction,
    );

    if (remainingEligibleWorkers > 0) {
      return { boothCancelled: false, completedTicketJob: null };
    }

    const { completedTicketJob } = await cancelStallJobRecord(
      current,
      input.reason_code ?? null,
      input.reason_text ?? null,
      actorId,
      transaction,
      {
        source: "auto_cancel_last_worker_excluded",
        triggered_by_worker_code: workerCode,
      },
    );

    return { boothCancelled: true, completedTicketJob };
  });

  publishNotification({
    type: "TICKET_WORKER_CANCELLED_FROM_BOOTH",
    title: "Worker removed from booth",
    message: `Worker ${workerCode} was removed from booth ${boothCode} (ticket ${ticketNo}) by admin.`,
    payload: {
      ticketNumber: ticketJob.ticket_number,
      ticketNo,
      boothCode,
      worker_code: workerCode,
      status: TICKET_WORKER_STATUS.CANCELLED,
    },
    audience: {
      roles: ["admin"],
    },
  });

  if (boothCancelled) {
    const cancelledTicketJob = await ticketJobRepository.findTicketJobById(ticketJob.id);
    const marketJob = await marketJobRepository.findMarketJobById(ticket.market_job_id);

    publishRealtimeEvent({
      type: "STALL_JOB_CANCELLED",
      title: "Stall job cancelled",
      message: `Stall job ${boothCode} was cancelled because its last remaining worker was removed.`,
      payload: {
        ticketNumber: cancelledTicketJob?.ticket_number ?? ticketJob.ticket_number,
        marketCode: marketJob?.marketCode ?? null,
        boothCode,
        status: TICKET_STATUS.CANCELLED,
      },
      worker_payload: {
        ticketNumber: cancelledTicketJob?.ticket_number ?? ticketJob.ticket_number,
        ticketNos: marketJob ? [marketJob.ticket_no] : [],
        marketCode: marketJob?.marketCode ?? null,
        boothCode,
        status: TICKET_STATUS.CANCELLED,
      },
      admin: true,
      worker_ids: await listStallJobWorkerIds(ticket),
    });

    await notifyVendorBoothCancelled({
      ticketId: ticket.id,
      ticketNo: marketJob?.ticket_no ?? "",
      marketName: marketJob?.marketName ?? "",
      boothCode,
      boothName: ticket.boothName,
      licensePlate: cancelledTicketJob?.license_plate ?? ticketJob.license_plate,
    });

    await handleTicketJobClosedByCascadeCancellation(completedTicketJob ?? null);
  }

  return {
    message: boothCancelled
      ? "Worker removed from booth successfully. The booth had no remaining workers and was cancelled automatically."
      : "Worker removed from booth successfully.",
    ticket_number: ticketJob.ticket_number,
    ticket_no: ticketNo,
    boothCode,
    worker_code: workerCode,
    status: TICKET_WORKER_STATUS.CANCELLED,
    booth_cancelled: boothCancelled,
  };
}

// Function Admin ส่ง/แก้ยอดสินค้าของ Booth หนึ่งใบแทน Worker ใช้ pipeline เดียวกับ submitTicketCompletion
// ทุกขั้นตอน ต่างแค่ requireRosterMembership: false (Admin ไม่ใช่สมาชิก TicketWorker) และบันทึก AdminActionLog เก็บเหตุผลที่เข้ามาส่งแทน
export async function overrideTicketProductCounts(
  ticketNumberParam: unknown,
  ticketNoParam: unknown,
  boothCodeParam: unknown,
  body: unknown,
  auth?: AccessTokenPayload,
): Promise<AdminOverrideCountResponse> {
  const ticketJob = await requireTicketJobByRef(ticketNumberParam);
  const ticketNo = parseReference(
    ticketNoParam,
    "INVALID_TICKET_NO",
    "TicketNo is invalid.",
  );
  const boothCode = parseReference(
    boothCodeParam,
    "INVALID_BOOTH_CODE",
    "BoothCode is invalid.",
  );
  const input = parseWithSchema(adminOverrideCountBodySchema, body);
  const actorId = requireActorId(auth);

  const result = await withTransaction(async (transaction) => {
    const submission = await ticketCompletionService.submitTicketCompletion({
      findTicket: (connection) =>
        boothJobRepository.findBoothJobForCompletionByTicketNumberAndTicketNoAndBoothCode(
          ticketJob.ticket_number,
          ticketNo,
          boothCode,
          connection,
        ),
      items: input.counts.map((item) => ({
        productCode: item.productCode,
        packageCode: item.packageCode,
        confirmed_quantity: item.actual_quantity,
      })),
      submittedByAccountId: actorId,
      submittedByRole: TICKET_SUBMITTER_ROLE.ADMIN,
      requireRosterMembership: false,
      connection: transaction,
    });
    const previousQuantityByKeyForLog = new Map(
      submission.originalProducts.map((product) => [
        `${product.productCode}::${product.packageCode}`,
        product.confirmed_quantity,
      ]),
    );

    await adminActionLogRepository.create(
      {
        vehicle_job_id: ticketJob.id,
        gate_ticket_id: submission.ticket.id,
        action_type: ADMIN_ACTION_TYPE.OVERRIDE_COUNT,
        reason_code: input.reason_code,
        reason_text: input.reason_text,
        actor_account_id: actorId,
        metadata: {
          boothCode: submission.ticket.boothCode,
          counts: input.counts.map((item) => ({
            productCode: item.productCode,
            packageCode: item.packageCode,
            previous_quantity:
              previousQuantityByKeyForLog.get(`${item.productCode}::${item.packageCode}`) ?? null,
            actual_quantity: item.actual_quantity,
          })),
        },
      },
      transaction,
    );

    return submission;
  });

  const previousQuantityByKey = new Map(
    result.originalProducts.map((product) => [
      `${product.productCode}::${product.packageCode}`,
      product.confirmed_quantity,
    ]),
  );
  const confirmedQuantityByKey = new Map(
    result.products.map((product) => [
      `${product.productCode}::${product.packageCode}`,
      product.confirmed_quantity,
    ]),
  );

  // submitTicketCompletion commit สถานะ Ticket เป็น DELIVERED ไปแล้วจริง จากนี้เป็นแค่ best-effort
  // notify vendor เท่านั้น ห้าม throw ออกไปทำให้ request ตอบ error ทั้งที่ยอดบันทึกสำเร็จแล้ว
  try {
    await ticketCompletionService.notifyTicketCompletionSubmitted(result);
  } catch (error) {
    logger.error("Failed to notify vendor after admin submitted ticket completion.", {
      ticketId: result.ticket.id,
      submissionId: result.submission.id,
      error,
    });
  }

  // Best-effort เช่นกัน — ถ้ามี Worker คนไหนในทีมของ TicketJob นี้หมดกะไปแล้ว และทุก Booth ถูกส่งยอด/
  // ยืนยัน/ยกเลิกครบแล้ว ให้ปล่อยทั้งทีมกลับคิวทันทีโดยไม่ต้องให้ Admin กด release-workers เพิ่มอีกขั้น
  try {
    await autoReleaseTicketJobWorkersIfShiftEnded(ticketJob, actorId);
  } catch (error) {
    logger.error("Failed to auto-release vehicle job workers after admin override count.", {
      ticketJobId: ticketJob.id,
      error,
    });
  }

  return {
    message: "Booth counts submitted and waiting for vendor confirmation.",
    ticket_number: ticketJob.ticket_number,
    boothCode: result.ticket.boothCode,
    status: result.ticket.status,
    reason_code: input.reason_code,
    reason_text: input.reason_text ?? null,
    products: input.counts.map((item) => {
      const key = `${item.productCode}::${item.packageCode}`;

      return {
        productCode: item.productCode,
        packageCode: item.packageCode,
        previous_quantity: previousQuantityByKey.get(key) ?? null,
        confirmed_quantity: confirmedQuantityByKey.get(key) ?? null,
      };
    }),
  };
}

// Function Admin สลับ Dispatch ของ TicketJob (false = คืน Worker ทั้งชุดเข้าคิวหน้าสุด, true = Dispatch ใหม่จากคิว ณ ตอนนั้น)
// อนุญาตเฉพาะก่อนทีม Scan ครบทุกคน (ก่อน is_ready) เพราะยังไม่มี Booth ไหนถูกส่งยอดได้เลย ต่างจาก cancelTicketJobAndRequeue ตรงที่ TicketJob/MarketJob/BoothJob เองไม่ถูกยกเลิก
export async function changeTicketJobToWait(
  ticketNumberParam: unknown,
  body: unknown,
  auth?: AccessTokenPayload,
): Promise<AdminVehicleWaitResponse> {
  const ticketJob = await requireTicketJobByRef(ticketNumberParam);
  const input = parseWithSchema(adminVehicleWaitBodySchema, body);
  const actorId = requireActorId(auth);

  const { updated, cancelledAssignments } = await withTransaction(async (transaction) => {
    // Lock แถว TicketJob ก่อน re-check ว่าทีมยัง Scan ไม่ครบแล้วเขียนจริง กัน race กับ worker
    // คนสุดท้ายที่อาจ Scan เข้ามาพร้อมกัน (เหตุผลเดียวกับ lock ใน closeCompletedTicketJobIfReady)
    await transaction.$queryRaw`SELECT id FROM ticket_jobs WHERE id = ${ticketJob.id} FOR UPDATE`;

    if (TERMINAL_JOB_STATUSES.includes(ticketJob.status)) {
      throw new ApiError(
        409,
        "VEHICLE_JOB_CLOSED",
        "Vehicle job is already closed and cannot change dispatch.",
      );
    }

    const readiness = await ticketJobRepository.getVehicleWorkReadiness(
      ticketJob.id,
      transaction,
    );

    if (readiness.is_ready) {
      throw new ApiError(
        409,
        "VEHICLE_JOB_ALREADY_STARTED",
        "The whole team has already checked in and started working; dispatch can no longer be changed.",
      );
    }

    const cancelled = input.dispatch
      ? []
      : await ticketJobLifecycleService.cancelActiveAssignmentsForTicketJob(
          ticketJob.id,
          transaction,
        );
    const result = await ticketJobRepository.setTicketJobDispatch(
      ticketJob.id,
      input.dispatch,
      input.dispatch ? VEHICLE_JOB_STATUS.WORKING : VEHICLE_JOB_STATUS.WAIT,
      transaction,
    );

    await adminActionLogRepository.create(
      {
        vehicle_job_id: ticketJob.id,
        action_type: ADMIN_ACTION_TYPE.VEHICLE_WAIT,
        reason_code: input.reason_code,
        reason_text: input.reason_text,
        actor_account_id: actorId,
        metadata: {
          dispatch: input.dispatch,
          worker_ids: cancelled.map((assignment) => assignment.worker_id),
        },
      },
      transaction,
    );

    return { updated: result, cancelledAssignments: cancelled };
  });

  let requeuedWorkerCodes: Array<string | null> = [];
  let openAppWorkerCodes: Array<string | null> = [];

  if (!input.dispatch && cancelledAssignments.length > 0) {
    const sortedAssignments = sortAssignmentsByAcceptedAt(cancelledAssignments);
    const candidateWorkerIds = sortedAssignments.map(
      (assignment) => assignment.worker_id,
    );

    // เช็คกะสดก่อนคืนเข้าคิวเสมอ — Worker ที่หมดกะไปแล้วต้องไป open_app ไม่ใช่ถูกดันกลับเข้า READY
    const { requeuedWorkerIds, openAppWorkerIds: openAppIds } =
      await requeueWorkersAtFrontRespectingShift(candidateWorkerIds);

    for (const workerId of requeuedWorkerIds) {
      sendWorkerSocketEvent(workerId, "WORKER_STATUS_CHANGED", {
        status: WORKER_WORK_STATUS.READY,
        reason: "vehicle_job_wait_requeue",
      });
    }
    for (const workerId of openAppIds) {
      sendWorkerSocketEvent(workerId, "WORKER_STATUS_CHANGED", {
        status: WORKER_WORK_STATUS.OPEN_APP,
        reason: "vehicle_job_wait_shift_ended",
      });
    }
    [requeuedWorkerCodes, openAppWorkerCodes] = await Promise.all([
      profileRepository.findWorkerCodesByAccountIds(requeuedWorkerIds),
      profileRepository.findWorkerCodesByAccountIds(openAppIds),
    ]);
    // ปล่อยให้ Worker ที่เพิ่งกลับเข้าคิวไหลไปรับงานคันอื่นที่ Dispatch อยู่ก่อนแล้วได้ทันที ไม่ต้อง
    // รอรอบ dispatch ถัดไป — best-effort เหมือน dispatchReadyWorkers อีกจุดด้านล่างในฟังก์ชันนี้
    if (requeuedWorkerIds.length > 0) {
      try {
        await dispatchReadyWorkers();
      } catch (error) {
        logger.error("Vehicle job set to wait but worker requeue dispatch failed.", {
          ticketJobId: ticketJob.id,
          error,
        });
      }
    }
  }

  if (input.dispatch) {
    try {
      await dispatchReadyWorkers(undefined, {
        vehicle_job_ids: [ticketJob.id],
      });
    } catch (error) {
      logger.error("Vehicle job dispatch was re-enabled but worker dispatch failed.", {
        error,
      });
    }
  }

  publishRealtimeEvent({
    type: "VEHICLE_JOB_WAIT",
    title: input.dispatch ? "Vehicle job dispatch re-enabled" : "Vehicle job set to wait",
    message: input.dispatch
      ? `Vehicle job ${ticketJob.ticket_number} was dispatched again by admin.`
      : `Vehicle job ${ticketJob.ticket_number} was set back to wait by admin.`,
    payload: {
      ticketNumber: ticketJob.ticket_number,
      dispatch_now: updated.dispatch_now,
      status: updated.status,
      reason_code: input.reason_code,
      worker_to_queue: requeuedWorkerCodes,
      worker_to_openapp: openAppWorkerCodes,
    },
    admin: true,
  });

  {
    const activeBooths = await boothJobRepository.listActiveBoothsByTicketJobId(
      ticketJob.id,
    );

    for (const booth of activeBooths) {
      const notifyInput = {
        ticketId: booth.id,
        ticketNo: booth.ticketNo,
        marketName: booth.marketName,
        boothCode: booth.boothCode,
        boothName: booth.boothName,
        licensePlate: ticketJob.license_plate,
      };

      if (input.dispatch) {
        await notifyVendorBoothDispatchResumed(notifyInput);
      } else {
        await notifyVendorBoothWait(notifyInput);
      }
    }
  }

  return {
    message: input.dispatch
      ? "Vehicle job dispatched again successfully."
      : "Vehicle job set to wait successfully.",
    ticket_number: updated.ticket_number,
    status: updated.status,
    dispatch_now: updated.dispatch_now,
    worker_to_queue: requeuedWorkerCodes,
    worker_to_openapp: openAppWorkerCodes,
    reason_code: input.reason_code,
    reason_text: input.reason_text ?? null,
  };
}

// Function Admin ปล่อย Worker ทั้งทีมของ TicketJob กลับคิวก่อนเวลา ใช้เมื่อส่งยอดครบทุก Booth แล้วไม่มี Booth ค้าง Reject
// ไม่ต้องรอ Gate ปิดรับ Ticket หรือ Financial Finalize เพราะ Worker หมดหน้าที่ทางกายภาพแล้ว คำนวณเงินทีหลังได้โดยไม่ต้องมี Worker อยู่
export async function releaseTicketJobWorkers(
  ticketNumberParam: unknown,
  body: unknown,
  auth?: AccessTokenPayload,
): Promise<AdminReleaseWorkersResponse> {
  const ticketJob = await requireTicketJobByRef(ticketNumberParam);
  const input = parseWithSchema(adminReleaseWorkersBodySchema, body);
  const actorId = requireActorId(auth);

  if (TERMINAL_JOB_STATUSES.includes(ticketJob.status)) {
    throw new ApiError(
      409,
      "VEHICLE_JOB_CLOSED",
      "Vehicle job is already closed; workers already returned to queue.",
    );
  }

  const releasableAssignments = await withTransaction(async (transaction) => {
    const lifecycleState = await ticketJobRepository.findTicketJobLifecycleState(
      ticketJob.id,
      transaction,
    );
    const tickets = (lifecycleState?.marketJobs ?? []).flatMap(
      (market) => market.tickets,
    );

    if (tickets.length === 0) {
      throw new ApiError(
        409,
        "NO_SUBMITTED_BOOTHS",
        "Vehicle job has no booths to release workers from yet.",
      );
    }

    // Worker ทางกายทำงานเสร็จตั้งแต่ส่งยอดครบ (DELIVERED) ไม่ต้องรอ Vendor ยืนยันหรือ TicketNumber ปิดทั้งคัน
    // REJECT ยังนับเป็น unresolved เพราะ Worker ต้องแก้ไขและส่งยอดใหม่ก่อน
    const hasUnresolvedBooth = tickets.some(
      (ticket) => !SUBMITTED_TICKET_STATUSES.includes(ticket.status),
    );

    if (hasUnresolvedBooth) {
      throw new ApiError(
        409,
        "BOOTHS_NOT_SUBMITTED",
        "Every booth must be submitted, confirmed, or cancelled (no pending submission or unresolved reject) before releasing workers.",
      );
    }

    // เรียงตาม accepted_at ก่อนคืนเข้าคิว (ท้ายคิว) — ให้ลำดับสัมพัทธ์ระหว่าง Worker ในทีมเดียวกัน
    // ตรงกับตอนเข้าคิวครั้งแรกเสมอ ไม่ใช่ลำดับที่ assignment ถูกสร้าง/dispatch
    const releasable = sortAssignmentsByAcceptedAt(
      await assignmentRepository.listReleasableAssignmentsByTicketJob(
        ticketJob.id,
        transaction,
      ),
    );

    if (releasable.length === 0) {
      throw new ApiError(
        409,
        "NO_RELEASABLE_WORKERS",
        "No workers are currently eligible to be released.",
      );
    }

    await assignmentRepository.releaseAssignments(
      releasable.map((assignment) => assignment.id),
      new Date(),
      transaction,
    );

    // เปลี่ยน status เป็น RELEASED (ไม่แตะ dispatchNow) กัน dispatchReadyWorkers ดึง worker กลับเข้ารถคันนี้ซ้ำ
    // จาก event อื่นในภายหลัง (เช่น Vendor Reject) — Gate เพิ่ม booth ใหม่หรือ Admin เปิดผ่าน /wait จะเปิด dispatch คืนเอง
    await ticketJobRepository.updateTicketJobStatus(
      ticketJob.id,
      VEHICLE_JOB_STATUS.RELEASED,
      transaction,
    );

    await adminActionLogRepository.create(
      {
        vehicle_job_id: ticketJob.id,
        action_type: ADMIN_ACTION_TYPE.WORKERS_RELEASED,
        reason_code: input.reason_code,
        reason_text: input.reason_text ?? null,
        actor_account_id: actorId,
        metadata: {
          worker_ids: releasable.map(
            (assignment) => assignment.worker_id,
          ),
        },
      },
      transaction,
    );

    return releasable;
  });

  const releasedWorkerAccountIds = releasableAssignments.map(
    (assignment) => assignment.worker_id,
  );
  const releasedWorkerCodes = await returnCompletedWorkersToQueue({
    vehicle_job: {
      ticket_number: ticketJob.ticket_number,
    },
    completed_worker_ids: releasedWorkerAccountIds,
  });

  publishRealtimeEvent({
    type: "VEHICLE_JOB_WORKERS_RELEASED",
    title: "Workers released early",
    message: `${releasedWorkerAccountIds.length} worker(s) were released from vehicle job ${ticketJob.ticket_number} by admin.`,
    payload: {
      ticketNumber: ticketJob.ticket_number,
      reason_code: input.reason_code,
      released_worker_codes: releasedWorkerCodes,
    },
    admin: true,
  });

  return {
    message: "Workers released back to the queue successfully.",
    ticket_number: ticketJob.ticket_number,
    released_worker_codes: releasedWorkerCodes,
    reason_code: input.reason_code,
    reason_text: input.reason_text ?? null,
  };
}

// Function ตัดสิน payment_status ของแถวรายได้ Worker รายวันหนึ่งแถว ตามลำดับความสำคัญ:
// cancel > success/partially_paid > admin_reject/worker_reject > null (ไม่เข้าเงื่อนไขไหนเลย ไม่ต้องนับมาแสดง)
function resolveDailyWorkerIncomePaymentStatus(
  record: DailyWorkerIncomeRecord,
  hasUnresolvedReject: boolean,
  isReleased: boolean,
): DailyWorkerIncomePaymentStatus | null {
  const { marketJob } = record;

  if (marketJob.status === VEHICLE_JOB_STATUS.CANCELLED) {
    return DAILY_WORKER_INCOME_PAYMENT_STATUS.CANCEL;
  }

  if (marketJob.status === VEHICLE_JOB_STATUS.COMPLETED) {
    if (record.status === TICKET_WORKER_STATUS.COMPLETED) {
      return DAILY_WORKER_INCOME_PAYMENT_STATUS.SUCCESS;
    }

    if (
      record.status === TICKET_WORKER_STATUS.CANCELLED &&
      record.finalEarningAmount &&
      record.finalEarningAmount.greaterThan(0)
    ) {
      return DAILY_WORKER_INCOME_PAYMENT_STATUS.PARTIALLY_PAID;
    }

    return null;
  }

  // ticket_no ยังไม่จบงาน (WAIT/WORKING) — ห้าม release ถ้ายังมี reject ค้างอยู่ (ดู BOOTHS_NOT_SUBMITTED)
  // reject ที่เจอตอน isReleased=true จึงต้องเกิดขึ้นหลัง release เสมอ ไม่มีทางสลับลำดับกันได้
  if (hasUnresolvedReject) {
    return isReleased
      ? DAILY_WORKER_INCOME_PAYMENT_STATUS.ADMIN_REJECT
      : DAILY_WORKER_INCOME_PAYMENT_STATUS.WORKER_REJECT;
  }

  return null;
}

const DAILY_WORKER_INCOME_RISK_TEXT = {
  WORKER_CANCELLED_BY_ADMIN: "Admin เตะคนงานกลางคัน",
  PARTIAL_PAY_CONFIRMED_STALLS_ONLY: "จ่ายเฉพาะแผงที่ยืนยันแล้ว",
  REJECTED_REQUIRES_ADMIN_CORRECTION: "แผงปฏิเสธหลังปล่อยคิว/ต้องให้ Admin แก้",
  REJECTION_CORRECTED_BY_ADMIN: "เคยปฏิเสธและ Admin แก้ยอดแล้ว",
  REJECTED_REQUIRES_WORKER_CORRECTION: "แผงปฏิเสธ รอชุดแรงงานแก้ยอด",
  COUNT_SUBMITTED_BY_ADMIN: "Admin ส่งยอดแทน",
  AUTO_CONFIRMED_BY_SYSTEM: "ระบบตัดยืนยัน",
  MARKET_CANCELLED: "ตลาดนี้ถูกยกเลิก",
  VEHICLE_JOB_CANCELLED: "งานถูกยกเลิก",
} as const;

function addDailyRiskText(messages: string[], message: string): void {
  if (!messages.includes(message)) {
    messages.push(message);
  }
}

function getDailyAdminActionType(log: unknown): string | null {
  if (!log) {
    return null;
  }

  const record = log as { actionType?: string | null; action_type?: string | null };

  return record.actionType ?? record.action_type ?? null;
}

function buildDailyWorkerIncomeRiskText(
  record: DailyWorkerIncomeRecord,
  paymentStatus: DailyWorkerIncomePaymentStatus,
  cancelLog: DailyWorkerIncomeRecord["marketJob"]["adminActionLogs"][number] | null,
): string {
  const { marketJob } = record;
  const { ticketJob } = marketJob;
  const messages: string[] = [];
  const tickets = marketJob.tickets;
  const submissions = tickets.flatMap((ticket) => ticket.completionSubmissions);
  const hasAdminSubmittedCount =
    submissions.some(
      (submission) =>
        String(submission.submittedByRole ?? "").toLowerCase() === TICKET_SUBMITTER_ROLE.ADMIN,
    ) ||
    tickets.some((ticket) =>
      (ticket.adminActionLogs ?? []).some(
        (log) => getDailyAdminActionType(log) === ADMIN_ACTION_TYPE.OVERRIDE_COUNT,
      ),
    ) ||
    marketJob.adminActionLogs.some(
      (log) => getDailyAdminActionType(log) === ADMIN_ACTION_TYPE.OVERRIDE_COUNT,
    );
  const hasAutoConfirmedBySystem = submissions.some(
    (submission) => submission.confirmedAt && !submission.resolvedByLineUserId,
  );
  const hasRejectedSubmission = submissions.some(
    (submission) => submission.rejectedAt,
  );

  if (
    record.status === TICKET_WORKER_STATUS.CANCELLED &&
    paymentStatus !== DAILY_WORKER_INCOME_PAYMENT_STATUS.CANCEL
  ) {
    addDailyRiskText(
      messages,
      DAILY_WORKER_INCOME_RISK_TEXT.WORKER_CANCELLED_BY_ADMIN,
    );
  }

  if (paymentStatus === DAILY_WORKER_INCOME_PAYMENT_STATUS.PARTIALLY_PAID) {
    addDailyRiskText(
      messages,
      DAILY_WORKER_INCOME_RISK_TEXT.PARTIAL_PAY_CONFIRMED_STALLS_ONLY,
    );
  }

  if (paymentStatus === DAILY_WORKER_INCOME_PAYMENT_STATUS.ADMIN_REJECT) {
    addDailyRiskText(
      messages,
      DAILY_WORKER_INCOME_RISK_TEXT.REJECTED_REQUIRES_ADMIN_CORRECTION,
    );
  }

  if (hasRejectedSubmission && hasAdminSubmittedCount) {
    addDailyRiskText(
      messages,
      DAILY_WORKER_INCOME_RISK_TEXT.REJECTION_CORRECTED_BY_ADMIN,
    );
  }

  if (paymentStatus === DAILY_WORKER_INCOME_PAYMENT_STATUS.WORKER_REJECT) {
    addDailyRiskText(
      messages,
      DAILY_WORKER_INCOME_RISK_TEXT.REJECTED_REQUIRES_WORKER_CORRECTION,
    );
  }

  if (hasAdminSubmittedCount) {
    addDailyRiskText(
      messages,
      DAILY_WORKER_INCOME_RISK_TEXT.COUNT_SUBMITTED_BY_ADMIN,
    );
  }

  if (hasAutoConfirmedBySystem) {
    addDailyRiskText(
      messages,
      DAILY_WORKER_INCOME_RISK_TEXT.AUTO_CONFIRMED_BY_SYSTEM,
    );
  }

  if (paymentStatus === DAILY_WORKER_INCOME_PAYMENT_STATUS.CANCEL) {
    const cancelActionType = getDailyAdminActionType(cancelLog);
    const isVehicleCancelLog = ticketJob.adminActionLogs.some((log) => log === cancelLog);
    const isMarketCancelLog = marketJob.adminActionLogs.some((log) => log === cancelLog);

    if (cancelActionType === ADMIN_ACTION_TYPE.VEHICLE_JOB_CANCELLED || isVehicleCancelLog) {
      addDailyRiskText(
        messages,
        DAILY_WORKER_INCOME_RISK_TEXT.VEHICLE_JOB_CANCELLED,
      );
    } else if (
      cancelActionType === ADMIN_ACTION_TYPE.MARKET_JOB_CANCELLED ||
      cancelActionType === ADMIN_ACTION_TYPE.STALL_JOB_CANCELLED ||
      isMarketCancelLog
    ) {
      addDailyRiskText(
        messages,
        DAILY_WORKER_INCOME_RISK_TEXT.MARKET_CANCELLED,
      );
    } else if (ticketJob.status === VEHICLE_JOB_STATUS.CANCELLED) {
      addDailyRiskText(
        messages,
        DAILY_WORKER_INCOME_RISK_TEXT.VEHICLE_JOB_CANCELLED,
      );
    } else if (marketJob.status === VEHICLE_JOB_STATUS.CANCELLED) {
      addDailyRiskText(
        messages,
        DAILY_WORKER_INCOME_RISK_TEXT.MARKET_CANCELLED,
      );
    }
  }

  return messages.length > 0 ? messages.join(", ") : "-";
}

// Function จัดรูปแบบแถวรายได้ Worker รายวันหนึ่งแถว คืน null เมื่อไม่เข้า payment_status ไหนเลย (ผู้เรียกต้องกรองออกก่อนแบ่งหน้า)
// Reuse ticketWorker.final_earning_amount ที่ finalize แล้วตรงๆ เป็น payable ห้ามคำนวณสูตรใหม่
function formatDailyWorkerIncomeItem(
  record: DailyWorkerIncomeRecord,
): DailyWorkerIncomeItemResponse | null {
  const { marketJob } = record;
  const { ticketJob } = marketJob;
  const matchingAssignments = ticketJob.assignments
    .filter((assignment) => assignment.workerId === record.workerId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const assignment = matchingAssignments[0] ?? null;
  // เวลาส่งยอดล่าสุดของ booth ล่าสุดใน ticket_no นี้ ไม่ว่า worker คนไหนในทีมเป็นคนกดส่ง ให้ค่าเดียวกันทุกแถวของ ticket_no เดียวกันเหมือน confirmedAt
  const submittedAtMs = Math.max(
    0,
    ...marketJob.tickets.flatMap((ticket) =>
      ticket.completionSubmissions.map((submission) => submission.createdAt.getTime()),
    ),
  );
  const hasUnresolvedReject = marketJob.tickets.some(
    (ticket) => ticket.status === TICKET_STATUS.REJECT,
  );
  const isReleased = assignment?.releasedAt != null;
  const paymentStatus = resolveDailyWorkerIncomePaymentStatus(
    record,
    hasUnresolvedReject,
    isReleased,
  );

  if (!paymentStatus) {
    return null;
  }

  // marketJob.adminActionLogs ครอบทั้งยกเลิก ticket_no ตรง (MARKET_JOB_CANCELLED) และ cascade จาก Booth สุดท้าย (STALL_JOB_CANCELLED)
  // ถ้าไม่มีทั้งคู่ แปลว่าถูกยกเลิกทางอ้อมจากการยกเลิกทั้ง TicketNumber จึง fallback ไปที่ log ระดับรถ
  const cancelLog =
    paymentStatus === DAILY_WORKER_INCOME_PAYMENT_STATUS.CANCEL
      ? ticketJob.adminActionLogs.find(
        (log) => getDailyAdminActionType(log) === ADMIN_ACTION_TYPE.VEHICLE_JOB_CANCELLED,
      ) ?? ticketJob.adminActionLogs[0] ?? marketJob.adminActionLogs.find(
        (log) =>
          getDailyAdminActionType(log) === ADMIN_ACTION_TYPE.MARKET_JOB_CANCELLED ||
          getDailyAdminActionType(log) === ADMIN_ACTION_TYPE.STALL_JOB_CANCELLED,
      ) ?? marketJob.adminActionLogs[0] ?? null
      : null;
  const riskText = buildDailyWorkerIncomeRiskText(record, paymentStatus, cancelLog);

  return {
    worker: {
      code: record.worker.laborCode,
      name: record.worker.fullName ?? record.worker.laborCode,
      shirt_number: record.worker.coatNo ?? null,
    },
    accepted_at: assignment?.acceptedAt?.toISOString() ?? null,
    shift: record.worker.timeWork ?? null,
    ticket_no: marketJob.ticketNo,
    plate: ticketJob.licensePlate,
    payable: record.finalEarningAmount?.toFixed(2) ?? "0.00",
    scanned_at: assignment?.scannedAt?.toISOString() ?? null,
    started_at: ticketJob.workStartedAt?.toISOString() ?? null,
    submitted_at: submittedAtMs > 0 ? new Date(submittedAtMs).toISOString() : null,
    confirmedAt: marketJob.completedAt?.toISOString() ?? null,
    released_at: assignment?.releasedAt?.toISOString() ?? null,
    payment_status: paymentStatus,
    cancellation:
      paymentStatus === DAILY_WORKER_INCOME_PAYMENT_STATUS.CANCEL
        ? {
          cancelled_at: record.cancelledAt?.toISOString() ?? null,
          cancelled_by_type: cancelLog?.actor.role ?? null,
          cancelled_by_name: cancelLog?.actor.fullName ?? null,
        }
        : null,
    riskText,
  };
}

// Function ดึงรายได้ Worker รายวันสำหรับ Admin ใน service flow
export async function listDailyWorkerIncome(query: unknown): Promise<{
  data: DailyWorkerIncomeItemResponse[];
  available_worker_codes: string[];
  available_shifts: string[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
}> {
  const filters = parseWithSchema(adminDailyWorkerIncomeQuerySchema, query);
  const dateFrom = filters.date ?? filters.date_from;
  const dateTo = filters.date ?? filters.date_to;
  const dateRange = buildBangkokDateSpanRange(dateFrom, dateTo);
  const page = filters.page ?? 1;
  const limit = filters.limit ?? DEFAULT_PAGE_LIMIT;
  const result = await adminJobsRepository.listDailyWorkerIncome({
    workerCode: filters.worker_code,
    status: filters.status,
    shift: filters.shift,
    search: filters.search,
    ...dateRange,
  });

  // payment_status derive จากหลายตาราง ไม่ใช่ column เดียวที่ WHERE/paginate ใน DB ได้ตรงๆ จึงต้อง
  // format+กรองแถวที่ไม่เข้าเงื่อนไขออกก่อน แล้วแบ่งหน้าใน service layer (เหมือน listTicketJobOperations กับ operation_status)
  const items = result.data
    .map(formatDailyWorkerIncomeItem)
    .filter((item): item is DailyWorkerIncomeItemResponse => item !== null);
  const start = (page - 1) * limit;
  const pagedItems = items.slice(start, start + limit);

  return {
    data: pagedItems,
    available_worker_codes: result.available_worker_codes,
    available_shifts: result.available_shifts,
    pagination: {
      page,
      limit,
      total: items.length,
      total_pages: Math.ceil(items.length / limit),
    },
  };
}

// Function format หนึ่งแถวรายงานค่าลงสินค้าแผงค้ารายวันสำหรับ Admin — ใช้ snapshot/ยอด finalize จริง
// ตรงๆ ห้ามคำนวณ fee ใหม่จาก rate ปัจจุบัน ตาม docs/backend-missing-apis-spec V8.md ข้อ 28.2/28.5
function formatDailyStallFeeItem(record: DailyStallFeeRecord): DailyStallFeeItemResponse {
  const { ticket } = record.product;
  const { marketJob } = ticket;
  const { ticketJob } = marketJob;

  return {
    id: record.id,
    business_date: formatBangkokDate(record.finalizedAt),
    finalized_at: record.finalizedAt.toISOString(),
    booth_code: ticket.boothCode,
    plate: ticketJob.licensePlate,
    plate_province: ticketJob.licensePlateProvince,
    ticket_no: marketJob.ticketNo,
    market_code: marketJob.marketCode,
    market_name: marketJob.marketName,
    product_code: record.product.productCode,
    product_full_code: record.product.productFullCode,
    product_name: record.product.productName,
    package_code: record.product.packageCode,
    package_name: record.product.packageName,
    confirmed_quantity: record.confirmedQuantity.toFixed(2),
    stall_fee_rounded: record.stallFeeRounded.toFixed(2),
  };
}

// Function ดึงรายงานค่าลงสินค้าแผงค้ารายวันสำหรับ Admin — filter/summary/pagination ทั้งหมดทำที่ DB layer
// ไม่ paginate ใน service เหมือน listDailyWorkerIncome เพราะไม่มี field ที่ derive ข้ามตารางแบบ payment_status
export async function listDailyStallFees(query: unknown): Promise<DailyStallFeeListResponse> {
  const filters = parseWithSchema(adminDailyStallFeeQuerySchema, query);
  const dateRange = buildBangkokDateSpanRange(filters.date_from, filters.date_to);
  // date_from/date_to บังคับใน adminDailyStallFeeQuerySchema แล้ว (ไม่ใช่ optionalDateString) จึง
  // การันตีได้ว่า buildBangkokDateSpanRange คืน startAt/endAt เสมอ ไม่มีทางเป็น undefined ที่นี่
  const result = await adminJobsRepository.listDailyStallFees({
    startAt: dateRange.startAt as Date,
    endAt: dateRange.endAt as Date,
    search: filters.search,
    productCode: filters.product_code,
    packageCode: filters.package_code,
    page: filters.page,
    limit: filters.limit,
  });

  return {
    data: result.data.map(formatDailyStallFeeItem),
    summary: {
      row_count: result.summary.row_count,
      stall_count: result.summary.stall_count,
      confirmed_quantity_total: result.summary.confirmed_quantity_total.toFixed(2),
      stall_fee_total: result.summary.stall_fee_total.toFixed(2),
    },
    available_products: result.available_products,
    available_packages: result.available_packages,
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total: result.total,
      total_pages: Math.ceil(result.total / filters.limit),
    },
  };
}

// Function format หนึ่งแถวรายงานค่าลงสินค้าแผงค้ารายเดือนสำหรับ Admin — id ประกอบจาก date_from/date_to/market_code/booth_code/shirt_color
// ตรงๆ (deterministic อยู่แล้วเพราะ group key unique ต่อแถว ไม่ต้องมี numeric tie-breaker เพิ่ม)
function formatMonthlyStallFeeItem(
  row: MonthlyStallFeeGroupRow,
  dateFrom: string,
  dateTo: string,
): MonthlyStallFeeItemResponse {
  return {
    id: `${dateFrom}:${dateTo}|${row.market_code}|${row.booth_code}|${row.shirt_color}`,
    market_code: row.market_code,
    market_name: row.market_name,
    booth_code: row.booth_code,
    shirt_color: row.shirt_color,
    financial_item_count: row.financial_item_count,
    debit_amount: new Prisma.Decimal(row.debit_amount).toFixed(2),
  };
}

// Function ดึงรายงานค่าลงสินค้าแผงค้ารายเดือนสำหรับ Admin — group ด้วย market_code+booth_code+shirt_color
// ที่ DB ชั้นเดียวผ่าน raw SQL (Prisma groupBy ทำ GROUP BY ข้าม relation ไม่ได้) summary/filter/pagination มาจาก DB ทั้งหมด ไม่โหลดมารวมใน memory
export async function listMonthlyStallFees(query: unknown): Promise<MonthlyStallFeeListResponse> {
  const filters = parseWithSchema(adminMonthlyStallFeeQuerySchema, query);
  const dateRange = buildBangkokDateSpanRange(filters.date_from, filters.date_to);
  // date_from/date_to บังคับใน adminMonthlyStallFeeQuerySchema แล้ว การันตีได้ว่า
  // buildBangkokDateSpanRange คืน startAt/endAt เสมอ ไม่มีทางเป็น undefined ที่นี่
  const result = await adminJobsRepository.listMonthlyStallFees({
    startAt: dateRange.startAt as Date,
    endAt: dateRange.endAt as Date,
    marketSearch: filters.market_search,
    boothSearch: filters.booth_search,
    shirtColor: filters.shirt_color,
    page: filters.page,
    limit: filters.limit,
  });

  return {
    period: {
      date_from: filters.date_from,
      date_to: filters.date_to,
    },
    data: result.data.map((row) => formatMonthlyStallFeeItem(row, filters.date_from, filters.date_to)),
    summary: {
      row_count: result.summary.row_count,
      stall_count: result.summary.stall_count,
      financial_item_count: result.summary.financial_item_count,
      debit_amount_total: result.summary.debit_amount_total.toFixed(2),
    },
    available_markets: result.available_markets,
    available_stalls: result.available_stalls,
    available_shirt_colors: result.available_shirt_colors,
    pagination: {
      page: filters.page,
      limit: filters.limit,
      total: result.total,
      total_pages: Math.ceil(result.total / filters.limit),
    },
  };
}
