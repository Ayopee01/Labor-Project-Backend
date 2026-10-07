// Import Library
import { Prisma } from "@prisma/client";
// Import Config
import { withTransaction } from "../db/prisma";
import { ACTIVE_ASSIGNMENT_STATUSES, ASSIGNMENT_STATUS, DAILY_WORKER_INCOME_PAYMENT_STATUS, SCANNED_ASSIGNMENT_STATUSES, SUBMITTED_TICKET_STATUSES, TERMINAL_JOB_STATUSES, TERMINAL_TICKET_STATUSES, TICKET_STATUS, TICKET_SUBMITTER_ROLE, TICKET_WORKER_STATUS, VEHICLE_JOB_STATUS, WORKER_OPEN_APP_REASON } from "../constants/status";
import { DEFAULT_PAGE_LIMIT } from "../constants/pagination";
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
import { publishDriverJobUpdate } from "./driver-stream.service";
import { publishRealtimeEvent, resolveTicketResultAudience } from "./shared/realtime-notification.service";
import { getRuntimeSettings } from "./shared/runtime-settings.service";
import * as ticketJobLifecycleService from "./shared/ticket-job-lifecycle.service";
import * as ticketFinancialService from "./shared/ticket-financial.service";
import { countBoothSeats, estimateBoothWorkerAmount, findBoothTicketWorkerId, MIN_ONE_WORKER_BOOTH_STATUSES, PAYOUT_SNAPSHOT_BOOTH_STATUSES, resolveBoothMemberTicketWorkerIds } from "./shared/booth-membership.service";
import * as ticketCompletionService from "./shared/ticket-completion.service";
import { handleTicketJobClosedByCascadeCancellation } from "./shared/ticket-job-closure.service";
import { notifyVendorBoothCancelled, notifyVendorBoothDispatchResumed, notifyVendorBoothWait } from "./shared/vendor-line-notification.service";
import { notifyTicketJobTeamScanReadiness } from "./worker.service";
// Import Queues
import { claimReadyWorkerForAssignment, getWorkerQueueStatus, markWorkerAssigned, markWorkerOpenApp, removeAssignmentTimeout, removeScanTimeout, removeScanWarning, scheduleAssignmentTimeout, scheduleScanTimeout, scheduleScanWarning } from "../queues/worker-queue";
import { autoReleaseTicketJobWorkersIfShiftEnded, dispatchReadyWorkers, requeueWorkersAtFrontRespectingShift, returnCompletedWorkersToQueue, sortAssignmentsByAcceptedAt } from "../queues/worker-dispatch";
// Import Websockets
import { sendWorkerSocketEvent } from "../websockets/worker.socket";
// Import Types
import type { AdminTicketJobFinancialResponse, AdminTicketJobFinancialRecord, AdminAddWorkerToBoothsResponse, AdminAssignmentResponse, AdminAssignWorkersResponse, AdminBoothMembershipResult, AdminBoothPayoutResult, AdminCancelAssignmentResponse, AdminCancelTicketWorkerFromBoothResponse, AdminCancelTicketWorkerResponse, AdminCancelTicketJobAndRequeueResponse, AdminExtendScanDeadlineResponse, AdminHistoryCancellationResponse, AdminHistoryGateChangeSummaryResponse, AdminHistoryGateTicketUpdateRecord, AdminHistoryRejectionResponse, AdminHistoryBoothResponse, AdminHistoryProductResponse, AdminHistoryTimelineItemResponse, AdminHistoryWorkerResponse, AdminTicketJobAssignmentCancelResponse, HistoryStatusValue, HistoryFlagValue, DailyStallFeeItemResponse, DailyStallFeeListResponse, DailyStallFeeRecord, DailyWorkerIncomeItemResponse, DailyWorkerIncomePaymentStatus, DailyWorkerIncomeRecord, MonthlyStallFeeGroupRow, MonthlyStallFeeItemResponse, MonthlyStallFeeListResponse, AdminMarketJobActionResponse, AdminOverrideCountResponse, AdminReleaseWorkersResponse, AdminScanDeadlineAssignmentResponse, AdminStallJobActionResponse, AdminTicketJobHistoryItemResponse, AdminTicketJobHistoryRecord, AdminTicketJobOperationListResponse, AdminVehicleWaitResponse, AdminWorkerPayoutPreviewResponse, TicketJobHistorySummaryRecord, TicketJobHistorySummaryResponse } from "../types/admin-jobs.type";
import { HISTORY_FLAG_VALUES } from "../types/admin-jobs.type";
import { MASTER_WORKER_STATUS } from "../types/admin-workers.type";
import type { MasterWorkerDto } from "../types/admin-workers.type";
import type { AccessTokenPayload } from "../types/auth.type";
import type { GateTicketChangeSummary } from "../types/gate.type";
import type { CompletedTicketJobResult, BoothJobDto, MarketJobDto, TicketJobAssignmentDto, TicketJobDto, VehicleWorkReadinessDto } from "../types/worker.type";
import type { BoothMembershipRecord } from "../types/shared/booth-membership.type";
import type { DbConnection } from "../types/shared/common.type";
import type { BoothPayoutRecalculation } from "../types/shared/ticket-financial.type";
import { ADMIN_ACTION_TYPE, GATE_TICKET_UPDATE_REASON_CODE } from "../types/shared/admin-action-log.type";
import type { AdminActionLogDto } from "../types/shared/admin-action-log.type";
import { WORKER_ASSIGNMENT_EVENT_TYPE } from "../types/shared/worker-assignment-event.type";
import { WORKER_WORK_STATUS } from "../types/shared/worker-status.type";
// Import Validation
import { parseRequiredReference, parseWithSchema } from "../validation/parser";
import { adminAddWorkerToBoothsBodySchema, adminAssignWorkersBodySchema, adminDailyStallFeeQuerySchema, adminDailyWorkerIncomeQuerySchema, adminExtendScanDeadlineBodySchema, adminMonthlyStallFeeQuerySchema, adminOverrideCountBodySchema, adminReleaseWorkersBodySchema, adminTicketJobAssignmentCancelBodySchema, adminTicketJobListQuerySchema, adminTicketJobOperationsQuerySchema, adminVehicleWaitBodySchema, adminWorkerPayoutPreviewQuerySchema } from "../validation/schemas";
// Import Utils
import { requireActorId } from "../utils/actor";
import ApiError from "../utils/api-error";
import { buildVehicleOperationSummary, formatVehicleOperationItem } from "../utils/admin-job-operations.formatter";
import { isTimeInWorkSchedule } from "../utils/shift";
import { logger } from "../utils/logger";
import { buildBangkokDateSpanRange, buildDeadline, formatBangkokDate, getDelayUntil, toUnixMs } from "../utils/time";
import { buildWorkerAssignedPayload, buildWorkerQueueSocketPayload } from "../utils/worker-payload";

/* -------------------------------------- Functions -------------------------------------- */

// Function แปลง WorkerAssignmentEvent type เป็น Timeline type
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
    case WORKER_ASSIGNMENT_EVENT_TYPE.CLOSED_BEFORE_SCAN:
      return "WORKER_CLOSED_BEFORE_SCAN";
    default:
      return eventType;
  }
}

// Function สร้างข้อความอธิบาย Admin action หนึ่งรายการสำหรับ Timeline
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
    case ADMIN_ACTION_TYPE.BOOTH_MEMBERS_ADDED:
      return `${actor} added a worker back to booth(s).`;
    default:
      return `${actor} performed ${log.action_type}.`;
  }
}

// Function หา log การยกเลิก assignment นี้ (ไม่มีใช้ log ยกเลิกทั้งรถแทน)
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

  if (vehicleCancelLogs[0]) {
    return vehicleCancelLogs[0];
  }

  // รถถูกปิดเป็น CANCELLED เพราะ Admin ยกเลิกตลาด/แผงจนหมด (ไม่มี log ยกเลิกทั้งคัน) ใช้ log ยกเลิกล่าสุดของ Admin
  const cascadeCancelLogs = adminActionLogs
    .filter(
      (log) =>
        (log.action_type === ADMIN_ACTION_TYPE.MARKET_JOB_CANCELLED ||
          log.action_type === ADMIN_ACTION_TYPE.STALL_JOB_CANCELLED) &&
        log.reason_code !== GATE_TICKET_UPDATE_REASON_CODE,
    )
    .sort((a, b) => b.created_at.localeCompare(a.created_at));

  return cascadeCancelLogs[0] ?? null;
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

// Function หา log การยกเลิก Business Ticket นี้ (ไม่มีใช้ log ยกเลิกทั้งรถแทน)
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

// Function หา log การยกเลิกแผงนี้ (ไม่มีไล่หาระดับ Business Ticket แล้วรถ)
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

// Function หาชื่อ Gate ที่ทำรายการ (ไม่มีชื่อ Gate client ใช้ Gate {GateNo})
function resolveGateActorName(gateClientName: string | null, gateNo: string | null): string {
  return gateClientName ?? (gateNo ? `Gate ${gateNo}` : "Gate");
}

// Function ตรวจว่า log เป็นการยกเลิกตลาด/แผงที่เกิดจาก Gate แก้ไขตั๋ว (ไม่ใช่ Admin)
function isGateTicketUpdateLog(log: AdminActionLogDto): boolean {
  return log.reason_code === GATE_TICKET_UPDATE_REASON_CODE && log.actor_account_id === null;
}

// Function สร้างข้อมูลการยกเลิกจาก log (หา log ไม่เจอให้ field เป็น null)
function formatCancellationResponse(
  isCancelled: boolean,
  cancelLog: AdminActionLogDto | null,
): AdminHistoryCancellationResponse | null {
  if (!isCancelled) {
    return null;
  }

  const isGateLog = cancelLog !== null && isGateTicketUpdateLog(cancelLog);
  const gateNo = cancelLog?.metadata?.gate_no;

  return {
    cancelled_at: cancelLog?.created_at ?? null,
    reason_code: cancelLog?.reason_code ?? null,
    reason_text: cancelLog?.reason_text ?? null,
    cancelled_by_type: isGateLog ? "gate" : cancelLog?.actor_role ?? null,
    cancelled_by_name: isGateLog
      ? resolveGateActorName(
        cancelLog.actor_gate_client_name,
        typeof gateNo === "string" ? gateNo : null,
      )
      : cancelLog?.actor_full_name ?? null,
  };
}

// Function หา log การ release ที่ตรงกับ worker คนนี้ (หลาย log เลือกที่ใกล้ releasedAt ที่สุด)
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

// Function เลือก assignment ที่กดรับล่าสุดของแต่ละ worker (ไม่เคยกดรับไม่ถูกเลือก)
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

// Function สร้างรายชื่อ worker ของงานรถสำหรับ Work History (เฉพาะคนที่กดรับงาน ไม่ซ้ำคน)
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
    const closedBeforeScanEvent = assignment.events.find(
      (event) => event.eventType === WORKER_ASSIGNMENT_EVENT_TYPE.CLOSED_BEFORE_SCAN,
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
      // เวลาเริ่มงาน = workStartedAt ของรถ ถ้าทีมไม่เคยครบใช้ scannedAt ของคนนั้นแทน
      started_at: assignment.scannedAt
        ? (record.workStartedAt?.toISOString() ?? assignment.scannedAt.toISOString())
        : null,
      submitted_at: submittedAtByAssignmentId.get(assignment.id) ?? null,
      released_at: assignment.releasedAt?.toISOString() ?? null,
      // Admin ถอดออกจากรถแต่ยังได้เงินบางแผง = แสดงว่าจบงาน (รายละเอียดแผงที่ไม่ได้เงินดูที่ submission_worker_snapshot)
      final_status:
        assignment.status === ASSIGNMENT_STATUS.CANCELLED &&
        adminCancelledEvent &&
        hasPaidSubmittedBooth(record, assignment.workerId)
          ? ASSIGNMENT_STATUS.COMPLETED
          : assignment.status,
      cancellation:
        // รถปิดงานก่อน Worker คนนี้ Scan เข้างาน — ระบบปิดให้เอง ไม่ใช่ Admin ยกเลิก
        assignment.status === ASSIGNMENT_STATUS.CANCELLED && closedBeforeScanEvent && !adminCancelledEvent
          ? {
            cancelled_at: closedBeforeScanEvent.occurredAt.toISOString(),
            reason_code: "vehicle_job_closed_before_scan",
            reason_text: null,
            cancelled_by_type: "system",
            cancelled_by_name: null,
          }
          : assignment.status === ASSIGNMENT_STATUS.CANCELLED
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

// Function แปลง change_summary ของ GateRequestLog เป็น ChangeSummary ของ Timeline (เปลี่ยนชื่อ key ไม่ diff ใหม่)
function formatGateChangeSummary(
  changeSummary: GateTicketChangeSummary,
): AdminHistoryGateChangeSummaryResponse {
  return {
    MarketChanged: changeSummary.MarketChanged,
    DropoffPointChanged: changeSummary.DropoffPointChanged,
    AddedBoothCodes: changeSummary.Added,
    UpdatedBoothCodes: changeSummary.Updated,
    RemovedBoothCodes: changeSummary.Removed,
    PreviousWorkerCount: changeSummary.PreviousWorkerCount,
    WorkerCount: changeSummary.WorkerCount,
  };
}

// Function สร้าง Timeline ของงานรถจาก assignment event, การส่งยอด, การแก้ตั๋วจาก Gate และ admin log เรียงตามเวลา
function formatAdminHistoryTimeline(
  record: AdminTicketJobHistoryRecord,
  adminActionLogs: AdminActionLogDto[],
  gateTicketUpdates: AdminHistoryGateTicketUpdateRecord[],
  jobTimestamps: { ticket_created_at: string | null; completed_at: string | null },
): AdminHistoryTimelineItemResponse[] {
  const items: AdminHistoryTimelineItemResponse[] = [];

  // Gate Arrival ใช้ ticket_created_at ไม่ใช่ TicketJob.createdAt ถ้าไม่มี MarketJob เลยก็ไม่ต้องเดา
  if (jobTimestamps.ticket_created_at) {
    items.push({
      type: "GATE_ARRIVAL",
      occurred_at: jobTimestamps.ticket_created_at,
      actor_type: "system",
      actor_code: null,
      actor_name: null,
      description: `Vehicle ${record.ticketNumber} arrived at Gate.`,
    });
  }

  // log ยกเลิก assignment ที่รวมกับ event แล้ว ห้ามใส่ซ้ำเป็นรายการแยก
  const mergedCancelLogIds = new Set<number>();

  for (const assignment of record.assignments) {
    for (const event of assignment.events) {
      const isAdminCancelled = event.eventType === WORKER_ASSIGNMENT_EVENT_TYPE.ADMIN_CANCELLED;
      // รถปิดงานก่อน Worker คนนี้ Scan เข้างาน — ระบบปิดให้เอง ไม่ใช่ทั้ง Worker และ Admin
      const isClosedBeforeScan = event.eventType === WORKER_ASSIGNMENT_EVENT_TYPE.CLOSED_BEFORE_SCAN;
      const cancelLog = isAdminCancelled
        ? findAssignmentCancelLog(adminActionLogs, assignment.id)
        : null;
      const isAssignmentCancelLog =
        cancelLog?.action_type === ADMIN_ACTION_TYPE.ASSIGNMENT_CANCELLED;

      if (cancelLog && isAssignmentCancelLog) {
        mergedCancelLogIds.add(cancelLog.id);
      }

      items.push({
        type: mapAssignmentEventToTimelineType(event.eventType),
        occurred_at: event.occurredAt.toISOString(),
        actor_type: isAdminCancelled ? "admin" : isClosedBeforeScan ? "system" : "worker",
        actor_code: isAdminCancelled
          ? cancelLog?.actor_username ?? null
          : isClosedBeforeScan
          ? null
          : assignment.worker.laborCode,
        // Cancel Actor ต้องเป็นแอดมินที่กด Cancel (จาก AdminActionLog) ไม่ใช่ชื่อ Worker ที่ถูก Cancel
        actor_name: isAdminCancelled
          ? cancelLog?.actor_full_name ?? null
          : isClosedBeforeScan
          ? null
          : assignment.worker.fullName,
        description: isAdminCancelled && isAssignmentCancelLog
          ? `${cancelLog?.actor_username ?? "Admin"} cancelled the assignment of ${assignment.worker.laborCode}.`
          : isClosedBeforeScan
          ? `${assignment.worker.laborCode}: vehicle job closed before the worker scanned in.`
          : `${assignment.worker.laborCode}: ${event.eventType.toLowerCase()}.`,
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
        actor_code: releaseLog?.actor_username ?? null,
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
          actor_code: submitterCode,
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
            actor_code: null,
            actor_name: null,
            description: `Vendor rejected booth ${ticket.boothCode}.`,
          });
        }

        if (submission.confirmedAt) {
          items.push({
            type: "TICKET_CONFIRMED",
            occurred_at: submission.confirmedAt.toISOString(),
            actor_type: "system",
            actor_code: null,
            actor_name: null,
            description: `Vendor confirmed booth ${ticket.boothCode}.`,
          });
        }
      }
    }
  }

  // หนึ่งรายการต่อการแก้สำเร็จหนึ่งครั้ง แม้หลายแผง/สินค้าเปลี่ยนพร้อมกัน
  for (const update of gateTicketUpdates) {
    items.push({
      type: "GATE_TICKET_UPDATED",
      occurred_at: update.created_at,
      actor_type: "gate",
      actor_code: update.gate_no,
      actor_name: resolveGateActorName(update.gate_client_name, update.gate_no),
      description: `Gate ${update.gate_no ?? "-"} updated ticket ${update.ticket_no ?? "-"}.`,
      event_id: `gate_request:${update.id}:updated`,
      ticket_no: update.ticket_no,
      change_summary: formatGateChangeSummary(update.change_summary),
      change_details: update.change_details,
    });
  }

  for (const log of adminActionLogs) {
    // log ยกเลิกตลาด/แผงจาก Gate แสดงผ่าน GATE_TICKET_UPDATED แล้ว ห้ามซ้ำเป็น ADMIN_ACTION
    if (mergedCancelLogIds.has(log.id) || isGateTicketUpdateLog(log)) {
      continue;
    }

    items.push({
      type: "ADMIN_ACTION",
      occurred_at: log.created_at,
      actor_type: "admin",
      actor_code: log.actor_username,
      actor_name: log.actor_full_name,
      description: describeAdminAction(log),
    });
  }

  if (record.status === VEHICLE_JOB_STATUS.COMPLETED && jobTimestamps.completed_at) {
    items.push({
      type: "JOB_COMPLETED",
      occurred_at: jobTimestamps.completed_at,
      actor_type: "system",
      actor_code: null,
      actor_name: null,
      description: `Vehicle job ${record.ticketNumber} completed.`,
    });
  }

  return items.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
}

// Function หาเวลาและระยะเวลาระดับงานรถสำหรับ Work History (หาไม่ได้คืน null)
function deriveAdminHistoryJobTimestamps(record: AdminTicketJobHistoryRecord): {
  ticket_created_at: string | null;
  work_started_at: string | null;
  submitted_complete_at: string | null;
  completed_at: string | null;
  duration_seconds: number | null;
} {
  // ticket_created_at = TicketCreatedAt ที่เร็วที่สุดของ Business Ticket ในรถคันนี้
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

// Type ข้อมูลเจ้าของแผงที่ดึงมาแล้ว ใช้หาผู้ตีกลับยอดผ่าน LINE
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

// Function หาผู้ที่ตีกลับยอดผ่าน LINE (เช็คเจ้าของแผงก่อน แล้วค่อยสมาชิกแผง)
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

// Function ระบุว่ายอดถูกยืนยันโดย vendor, timeout หรือยังไม่ยืนยัน (null)
function resolveConfirmedByType(
  submission: AdminTicketJobHistoryRecord["marketJobs"][number]["tickets"][number]["completionSubmissions"][number] | null,
): "vendor" | "timeout" | null {
  if (!submission?.confirmedAt) {
    return null;
  }

  return submission.resolvedByLineUserId ? "vendor" : "timeout";
}

// Function จัดรูปแบบกลุ่ม worker ใน snapshot ของ submission
function formatSubmissionWorkerSnapshot(
  submission: AdminTicketJobHistoryRecord["marketJobs"][number]["tickets"][number]["completionSubmissions"][number],
  ticket: AdminTicketJobHistoryRecord["marketJobs"][number]["tickets"][number],
  ticketNo: string,
  adminActionLogs: AdminActionLogDto[],
): AdminHistoryBoothResponse["submission_worker_snapshot"] {
  const excludedTicketWorkerIds = new Set(
    (ticket.workerExclusions ?? []).map((exclusion) => exclusion.ticketWorkerId),
  );

  return submission.workerSnapshots.map((snapshot) => {
    const isRemoved = excludedTicketWorkerIds.has(snapshot.ticketWorkerId);
    const removalLog = isRemoved
      ? findWorkerBoothRemovalLog(adminActionLogs, snapshot.ticketWorker.workerId, ticket.id, ticketNo, ticket.boothCode)
      : null;

    return {
      worker_code: snapshot.ticketWorker.worker.laborCode,
      full_name: snapshot.ticketWorker.worker.fullName ?? snapshot.ticketWorker.worker.laborCode,
      // CANCELLED = Admin ถอดออกจากแผงนี้แบบไม่ให้เงิน
      status: isRemoved ? "CANCELLED" : "PAID",
      cancellation: isRemoved
        ? {
          cancelled_at: removalLog?.created_at ?? null,
          reason_code: removalLog?.reason_code ?? null,
          reason_text: removalLog?.reason_text ?? null,
          cancelled_by_type: removalLog?.actor_role ?? null,
          cancelled_by_name: removalLog?.actor_full_name ?? null,
        }
        : null,
    };
  });
}

// Function หา log ล่าสุดที่ Admin ถอด worker ออกจากแผงนี้แบบไม่ให้เงิน (ถอดรายแผง หรือเลือกไม่ให้เงินตอนถอดจากรถ/ใบ)
function findWorkerBoothRemovalLog(
  adminActionLogs: AdminActionLogDto[],
  workerId: number,
  boothJobId: number,
  ticketNo: string,
  boothCode: string,
): AdminActionLogDto | null {
  const removalActions: string[] = [
    ADMIN_ACTION_TYPE.ASSIGNMENT_CANCELLED,
    ADMIN_ACTION_TYPE.TICKET_WORKER_CANCELLED,
    ADMIN_ACTION_TYPE.TICKET_WORKER_CANCELLED_FROM_BOOTH,
  ];
  const matches = adminActionLogs.filter((log) => {
    const metadata = (log.metadata ?? {}) as {
      worker_id?: number;
      booth_payouts?: Array<{ ticket_no?: string; booth_code?: string; paid?: boolean }>;
    };

    if (!removalActions.includes(log.action_type) || metadata.worker_id !== workerId) {
      return false;
    }

    return (
      (log.action_type === ADMIN_ACTION_TYPE.TICKET_WORKER_CANCELLED_FROM_BOOTH && log.gate_ticket_id === boothJobId) ||
      (metadata.booth_payouts ?? []).some(
        (payout) => payout.ticket_no === ticketNo && payout.booth_code === boothCode && payout.paid === false,
      )
    );
  });

  return matches.at(-1) ?? null;
}

// Function ตรวจว่า worker ยังได้เงินจากแผงที่ส่งยอดแล้วอย่างน้อย 1 แผง (มีชื่อในรายชื่อส่งยอดและไม่ถูกถอด)
function hasPaidSubmittedBooth(record: AdminTicketJobHistoryRecord, workerId: number): boolean {
  return record.marketJobs.some((market) =>
    market.tickets.some((ticket) => {
      if (ticket.status !== TICKET_STATUS.COMPLETED && ticket.status !== TICKET_STATUS.DELIVERED) {
        return false;
      }

      const latestSubmission = ticket.completionSubmissions.at(-1);
      const excludedIds = new Set((ticket.workerExclusions ?? []).map((exclusion) => exclusion.ticketWorkerId));

      return (latestSubmission?.workerSnapshots ?? []).some(
        (snapshot) => snapshot.ticketWorker.workerId === workerId && !excludedIds.has(snapshot.ticketWorkerId),
      );
    }),
  );
}

// Function หารหัสของผู้ส่งยอด (Admin หรือ Worker)
function resolveSubmitterCode(
  submission: AdminTicketJobHistoryRecord["marketJobs"][number]["tickets"][number]["completionSubmissions"][number],
): string | null {
  return submission.submittedByRole === TICKET_SUBMITTER_ROLE.ADMIN
    ? submission.submittedByAccount?.username ?? null
    : submission.submittedByWorker?.laborCode ?? null;
}

// Function หาชื่อของผู้ส่งยอด (Admin หรือ Worker)
function resolveSubmitterName(
  submission: AdminTicketJobHistoryRecord["marketJobs"][number]["tickets"][number]["completionSubmissions"][number],
): string | null {
  return submission.submittedByRole === TICKET_SUBMITTER_ROLE.ADMIN
    ? submission.submittedByAccount?.fullName ?? null
    : submission.submittedByWorker?.fullName ?? null;
}

// Function จัดรูปแบบแผงสำหรับ Work History (ใช้ยอดเงินชุดเดียวกับหน้า financials) พร้อมข้อมูลการส่งยอด
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
      // ทีมยังไม่ Release แก้เองได้ (worker) ทีม Release ไปแล้วต้องให้ Admin แก้แทน (admin)
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
      ? formatSubmissionWorkerSnapshot(latestSubmission, ticket, market.ticketNo, adminActionLogs)
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

// Function รวมรายได้ของแต่ละ worker ทั้งรถ (เฉพาะ Business Ticket ที่ปิดยอดแล้ว)
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

// Function หา HistoryStatus ของงานรถ (ต้องตรงกับ buildHistoryStatusFilter ใน repository)
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

// Function รวม submission ของทุกแผงในรถเป็นรายการเดียว
function collectAllCompletionSubmissions(
  record: AdminTicketJobHistoryRecord,
): AdminTicketJobHistoryRecord["marketJobs"][number]["tickets"][number]["completionSubmissions"] {
  return record.marketJobs.flatMap((market) =>
    market.tickets.flatMap((ticket) => ticket.completionSubmissions),
  );
}

// Function หา HistoryFlags (เหตุการณ์ที่เคยเกิดขึ้น) เรียงตาม HISTORY_FLAG_VALUES
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
    // ตรวจทุก submission เพราะงานที่เคยถูกตีกลับแล้วแก้สำเร็จก็ต้องติด flag
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
    // ใช้ workerCountSnapshot ตอนส่งยอดเท่านั้น
    SUBMISSION_ROSTER_INCOMPLETE: submissions.some(
      (submission) => submission.workerCountSnapshot < record.workersRequired,
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

// Function จัดรูปแบบ Work History แบบละเอียดของงานรถหนึ่งคัน
function formatAdminTicketJobHistoryDetail(
  record: AdminTicketJobHistoryRecord,
  adminActionLogs: AdminActionLogDto[],
  gateTicketUpdates: AdminHistoryGateTicketUpdateRecord[],
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
    timeline: formatAdminHistoryTimeline(record, adminActionLogs, gateTicketUpdates, jobTimestamps),
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


// Function สร้าง response ของ action ที่ทำกับ Business Ticket
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

// Function สร้าง response ของ action ที่ทำกับแผง
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

// Function ดึงยอดแผงรายสินค้าที่บันทึกไว้ตอน Vendor ยืนยัน (สินค้าที่ปิดยอดแล้วต้องมีครบ)
function requireProductStallCharge(
  product: AdminTicketJobFinancialRecord["marketJobs"][number]["tickets"][number]["products"][number],
): {
  stallFeeRaw: Prisma.Decimal;
  stallFeeRounded: Prisma.Decimal;
  laborFeeRaw: Prisma.Decimal;
  productCharge: Prisma.Decimal;
} {
  const { stallFeeRaw, stallFeeRounded, laborFeeRaw, productCharge } = product;

  if (
    stallFeeRaw === null ||
    stallFeeRounded === null ||
    laborFeeRaw === null ||
    productCharge === null
  ) {
    throw new ApiError(
      500,
      "TICKET_FINANCIAL_STATE_INVALID",
      `Financialized ticket product ${product.id} does not have stall charge.`,
    );
  }

  return { stallFeeRaw, stallFeeRounded, laborFeeRaw, productCharge };
}

// Function จัดรูปแบบ Product Financial สำหรับ Admin
function formatAdminFinancialProduct(
  product: AdminTicketJobFinancialRecord["marketJobs"][number]["tickets"][number]["products"][number],
): AdminTicketJobFinancialResponse["booths"][number]["products"][number] {
  const financial = product.financial;
  const stallCharge = financial ? requireProductStallCharge(product) : null;

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
    financial: financial && stallCharge
      ? {
          stall_fee_raw: stallCharge.stallFeeRaw.toFixed(4),
          stall_fee_rounded: stallCharge.stallFeeRounded.toFixed(2),
          labor_fee_raw: stallCharge.laborFeeRaw.toFixed(4),
          product_charge: stallCharge.productCharge.toFixed(2),
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

// Function จัดรูปแบบยอดเงินของแผงสำหรับ Admin (รวมจาก workerPayments ของแผงนี้เท่านั้น)
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

    laborFeeRaw = laborFeeRaw.plus(requireProductStallCharge(product).laborFeeRaw);
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

// Function รวมยอดเงินของทุกแผงเป็นยอดรวมระดับงานรถ
function sumBoothFinancials(
  booths: {
    financialized: boolean;
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
    // ยอดแผงมีตั้งแต่ตอนยืนยัน แต่ยอดรวมนับเฉพาะแผงที่ปิดยอดแล้ว ให้ตรงกับยอดค่าแรงและกองทุน
    if (booth.financialized && booth.final_stall_amount !== null) {
      stallFeeTotal = stallFeeTotal.plus(booth.final_stall_amount);
    }

    laborFeeTotal = laborFeeTotal.plus(booth.summary.labor_fee_raw);
    workerPayoutTotal = workerPayoutTotal.plus(booth.summary.worker_payout_total);
    fundAmount = fundAmount.plus(booth.summary.fund_amount);
  }

  return { stallFeeTotal, laborFeeTotal, workerPayoutTotal, fundAmount };
}

// Function ดึงงานรถตาม TicketNumber (ไม่พบ throw 404)
async function requireTicketJobByRef(
  idParam: unknown,
  connection?: Parameters<typeof ticketJobRepository.findTicketJobByRef>[1],
): Promise<TicketJobDto> {
  const ticketNumber = parseRequiredReference(
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

// Function บวกเวลาให้ deadline (ถ้าเลยแล้วเริ่มนับจากตอนนี้)
function extendDeadline(currentDeadline: string | null, minutes: number): Date {
  const now = Date.now();
  const currentTime = currentDeadline
    ? new Date(currentDeadline).getTime()
    : now;
  const baseTime = Math.max(now, currentTime);

  return new Date(baseTime + minutes * 60 * 1000);
}

// Function ตรวจว่า scan deadline ยังไม่หมด
function isScanDeadlineActive(scanDeadlineAt: string | null): boolean {
  if (!scanDeadlineAt) {
    return false;
  }

  const deadlineMs = new Date(scanDeadlineAt).getTime();

  return Number.isFinite(deadlineMs) && deadlineMs > Date.now();
}

// Function สร้าง response รายการ assignment ที่ต่อเวลา scan
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

// Function สร้าง response รายการ assignment สำหรับ Admin
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

// Function ดึง worker id ที่ยังมี assignment active ของงานรถ
async function listTicketJobWorkerIds(
  ticketJobId: number,
): Promise<number[]> {
  const assignments =
    await assignmentRepository.listActiveAssignmentsByTicketJob(ticketJobId);

  return [
    ...new Set(assignments.map((assignment) => assignment.worker_id)),
  ];
}

// Function ดึง worker id ที่ต้องได้แจ้งเตือนของแผง
async function listStallJobWorkerIds(ticket: BoothJobDto): Promise<number[]> {
  const ticketWorkers = await ticketWorkerRepository.listTicketWorkers(
    ticket.market_job_id,
  );

  if (ticketWorkers.length > 0) {
    // ตัดคนที่ถูกถอดออกไปแล้ว (roster CANCELLED หรือถูกถอดเฉพาะแผงนี้) — ใช้เกณฑ์เดียวกับแจ้งเตือนผลส่งยอด
    return resolveTicketResultAudience(ticket);
  }

  return listTicketJobWorkerIds(ticket.vehicle_job_id);
}

// Function ดึง Financial breakdown ของ TicketJob สำหรับ Admin
export async function getTicketJobFinancials(
  ticketNumberParam: unknown,
): Promise<AdminTicketJobFinancialResponse> {
  const ticketNumber = parseRequiredReference(
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

// Function ดึงข้อมูลผู้ตีกลับยอดผ่าน LINE ของทุกแผงในหน้านี้ในครั้งเดียว
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

// Function แปลงยอดรวม Work History เป็น JSON number (ปัดทศนิยมตาม detail ก่อนแปลง)
function formatTicketJobHistorySummary(
  summary: TicketJobHistorySummaryRecord,
): TicketJobHistorySummaryResponse {
  return {
    total: summary.total,
    completed: summary.completed,
    cancelled: summary.cancelled,
    stall_fee_total: summary.stall_fee_total.toDecimalPlaces(2).toNumber(),
    worker_income_total: summary.worker_income_total.toDecimalPlaces(2).toNumber(),
    fund_total: summary.fund_total.toDecimalPlaces(4).toNumber(),
  };
}

// Function ดึงประวัติงานรถสำหรับ Admin (มี page จะแนบ Summary ของทั้งชุดหลังกรอง)
export async function listTicketJobs(query: unknown): Promise<{
  data: AdminTicketJobHistoryItemResponse[];
  available_dropoff_points: string[];
  pagination?: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
  summary?: TicketJobHistorySummaryResponse;
}> {
  const filters = parseWithSchema(adminTicketJobListQuerySchema, query);
  const dateRange = buildBangkokDateSpanRange(filters.date_from, filters.date_to);
  const result = await adminJobsRepository.listTicketJobs({
    search: filters.search,
    status: filters.status,
    history_status: filters.history_status,
    dropoff_point: filters.dropoff_point,
    page: filters.page,
    limit: filters.limit,
    ...dateRange,
  });
  const ticketJobIds = result.data.map((ticketJob) => ticketJob.id);
  const [adminActionLogsByTicketJobId, gateTicketUpdatesByTicketJobId] = await Promise.all([
    adminActionLogRepository.listByTicketJobIds(ticketJobIds),
    adminJobsRepository.listGateTicketUpdatesByTicketJobIds(ticketJobIds),
  ]);
  const { ownerByBoothKey, memberNameByKey } = await buildHistoryRejectionActorContext(
    result.data,
  );
  const formatItem = (ticketJob: (typeof result.data)[number]) =>
    formatAdminTicketJobHistoryDetail(
      ticketJob,
      adminActionLogsByTicketJobId.get(ticketJob.id) ?? [],
      gateTicketUpdatesByTicketJobId.get(ticketJob.id) ?? [],
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
    ...(result.summary && { summary: formatTicketJobHistorySummary(result.summary) }),
  };
}

// Function ดึงรายการงานรถสำหรับบอร์ดจัดการของ Admin
export async function listTicketJobOperations(
  query: unknown,
): Promise<AdminTicketJobOperationListResponse> {
  const filters = parseWithSchema(adminTicketJobOperationsQuerySchema, query);
  const dateRange = buildBangkokDateSpanRange(
    filters.date_from,
    filters.date_to,
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

// Type เหตุผลของ Admin ที่ parse จาก body แล้ว (ReasonCode + ReasonText บังคับ)
type AdminActionReason = {
  reasonCode: string;
  reasonText: string;
};

// Function ยกเลิกงานรถทั้งคันใน DB (เรียกก่อนคืน worker เข้าคิว)
async function performTicketJobCancellation(
  ticketNumber: string,
  reason: AdminActionReason,
  actorId: number,
) {
  const existingTicketJob = await requireTicketJobByRef(ticketNumber);
  const ticketJobId = existingTicketJob.id;

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

      if (current.status === VEHICLE_JOB_STATUS.RELEASED) {
        throw new ApiError(
          409,
          "VEHICLE_JOB_RELEASED",
          "Vehicle job cannot be cancelled after its workers were released.",
        );
      }

      // ห้ามยกเลิกทั้งรถถ้ามีแผงที่รอ Vendor ยืนยันหรือยืนยันแล้ว (แผง REJECT ยกเลิกได้)
      const blockingBoothCodes = await boothJobRepository.listCancelBlockingBoothCodes(
        { ticketJobId },
        transaction,
      );

      if (blockingBoothCodes.length > 0) {
        throw new ApiError(
          409,
          "VEHICLE_JOB_ALREADY_SUBMITTED",
          "Vehicle job cannot be cancelled while a booth is awaiting vendor confirmation or already confirmed.",
          { boothCodes: blockingBoothCodes },
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
      // ดึงแผงที่ยังไม่จบก่อนยกเลิก เพื่อแจ้ง LINE หลัง commit
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
          reason_code: reason.reasonCode,
          reason_text: reason.reasonText,
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

  // แจ้ง Driver Web ว่ารถถูกยกเลิกแล้ว — เรียกหลัง transaction ข้างบน commit สำเร็จแล้วเท่านั้น
  publishDriverJobUpdate(ticketJobId, "DRIVER_JOB_TERMINAL");

  return { ticketJob, activeAssignments, ticketNos, activeBooths };
}

// Function ยกเลิกงานรถทั้งคันและคืน worker เข้าคิว
async function cancelTicketJobAndRequeue(
  ticketNumber: string,
  reason: AdminActionReason,
  auth?: AccessTokenPayload,
): Promise<AdminCancelTicketJobAndRequeueResponse> {
  const { ticketJob, activeAssignments, ticketNos, activeBooths } =
    await performTicketJobCancellation(ticketNumber, reason, requireActorId(auth));

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
    // แจ้ง Admin ทีละคนสำหรับ worker ที่หมดกะแล้ว เพื่อให้ตารางสถานะอัปเดต
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
      worker_status: WORKER_WORK_STATUS.READY,
      reason: "vehicle_job_cancelled_requeue",
    },
    worker_ids: requeuedWorkerIds,
  });
  // worker ที่หมดกะต้องได้ FCM ด้วย ไม่งั้นแอปที่ปิดอยู่จะไม่รู้ว่างานถูกยกเลิก
  if (openAppWorkerIds.length > 0) {
    publishRealtimeEvent({
      type: "VEHICLE_JOB_CANCELLED",
      title: "Vehicle job cancelled",
      message: `Vehicle job ${ticketJob.ticket_number} was cancelled.`,
      worker_payload: {
        ticketNumber: ticketJob.ticket_number,
        ticketNos,
        status: ticketJob.status,
        requeued: false,
        worker_status: WORKER_WORK_STATUS.OPEN_APP,
        reason: "vehicle_job_cancelled_shift_ended",
      },
      worker_ids: openAppWorkerIds,
    });
  }
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

// Function ยกเลิกตาม scope ที่ระบุ (ทั้งรถ, Business Ticket, แผง หรือ worker)
export async function cancelTicketJobAssignment(
  body: unknown,
  auth?: AccessTokenPayload,
): Promise<AdminTicketJobAssignmentCancelResponse> {
  const input = parseWithSchema(adminTicketJobAssignmentCancelBodySchema, body);
  const reason: AdminActionReason = { reasonCode: input.reason_code, reasonText: input.reason_text };
  const removalRequest: WorkerRemovalRequest = {
    ...reason,
    boothPayouts: input.booth_payouts ?? [],
  };

  if (input.boothCode && !input.ticket_no) {
    throw new ApiError(
      400,
      "INVALID_CANCEL_SCOPE",
      "boothCode requires ticket_no to also be specified.",
    );
  }

  // เลือกสิทธิ์เงินรายแผงได้เฉพาะตอนถอด worker ออกจากรถหรือ Business Ticket
  if (input.booth_payouts && (!input.worker_code || input.boothCode)) {
    throw new ApiError(
      400,
      "INVALID_CANCEL_SCOPE",
      "booth_payouts is only allowed when removing a worker from a vehicle job or business ticket.",
    );
  }

  if (!input.ticket_no) {
    return input.worker_code
      ? cancelAssignment(input.ticket_number, input.worker_code, removalRequest, auth)
      : cancelTicketJobAndRequeue(input.ticket_number, reason, auth);
  }

  if (input.boothCode && input.worker_code) {
    return cancelTicketWorkerFromBooth(
      input.ticket_number,
      input.ticket_no,
      input.boothCode,
      input.worker_code,
      removalRequest,
      auth,
    );
  }

  if (input.boothCode) {
    return cancelStallJobByTicketContext(
      input.ticket_number,
      input.ticket_no,
      input.boothCode,
      reason,
      auth,
    );
  }

  if (input.worker_code) {
    return cancelTicketWorker(
      input.ticket_number,
      input.ticket_no,
      input.worker_code,
      removalRequest,
      auth,
    );
  }

  return cancelMarketJobByTicketContext(
    input.ticket_number,
    input.ticket_no,
    reason,
    auth,
  );
}

// Config สถานะแผงที่ยังไม่จบ (ยังเพิ่มคนเข้ามาทำได้)
const UNFINISHED_BOOTH_STATUSES: string[] = [
  TICKET_STATUS.WAIT,
  TICKET_STATUS.WORKING,
  TICKET_STATUS.REJECT,
];

// Config สถานะแผงที่ยังไม่ส่งยอด (worker บนรถทุกคนเป็นสมาชิกแผงอัตโนมัติ)
const OPEN_BOOTH_STATUSES: string[] = [TICKET_STATUS.WAIT, TICKET_STATUS.WORKING];

// Function คืน worker ที่ดึงออกจากคิวไว้กลับหน้าคิว เมื่อ transaction ของ Admin ล้ม (assignment ไม่ถูกสร้าง)
async function restoreClaimedWorkers(workerIds: number[], error: unknown): Promise<never> {
  if (workerIds.length > 0) {
    try {
      await requeueWorkersAtFrontRespectingShift(workerIds);
    } catch (requeueError) {
      logger.error("Failed to return claimed workers to the queue after manual assignment failed.", {
        workerIds,
        error: requeueError,
      });
    }
  }

  throw error;
}

// Function สร้าง assignment ให้ worker ที่ Admin เลือกจากคิว (ต้อง active, ready ในคิว, อยู่ในกะ และไม่มีงานอื่น)
async function createManualAssignmentInTransaction(
  ticketJobId: number,
  worker: MasterWorkerDto,
  acceptDeadlineMs: number,
  fillsRemovedSlot: boolean,
  claimedWorkerIds: number[],
  transaction: DbConnection,
): Promise<TicketJobAssignmentDto> {
  const workerCode = worker.labor_code;

  // lock worker ก่อนเช็คงานเดิม กัน assign คนเดียวกันพร้อมกัน
  await transaction.$queryRaw`SELECT id FROM master_workers WHERE id = ${worker.id} FOR UPDATE`;

  if (worker.status !== MASTER_WORKER_STATUS.ACTIVE) {
    throw new ApiError(403, "WORKER_NOT_ACTIVE", `Worker ${workerCode} is not active.`);
  }

  if (await assignmentRepository.findCurrentAssignmentByWorker(worker.id, transaction)) {
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

  // ห้าม assign worker ที่อยู่นอกเวลากะ แม้สถานะคิวเป็น READY
  const workerSchedule = await workScheduleRepository.findCurrentByAccountId(worker.id, transaction);

  if (!workerSchedule || !isTimeInWorkSchedule(workerSchedule)) {
    throw new ApiError(
      403,
      "WORKER_OUTSIDE_WORK_SHIFT",
      `Worker ${workerCode} is outside their work shift and cannot be assigned a job.`,
    );
  }

  // ดึงออกจากคิวแบบ atomic ก่อนสร้าง assignment ถ้า dispatch ดึงไปก่อนแล้วจะได้ false
  if (!(await claimReadyWorkerForAssignment(worker.id))) {
    throw new ApiError(
      409,
      "WORKER_NOT_READY",
      `Worker ${workerCode} must be ready in queue before admin can assign a job.`,
    );
  }

  claimedWorkerIds.push(worker.id);

  return assignmentRepository.createAssignment(
    ticketJobId,
    worker.id,
    buildDeadline(acceptDeadlineMs),
    transaction,
    fillsRemovedSlot,
  );
}

// Function ตรวจว่างานรถยังมีช่องให้เพิ่มคนตาม workers_required (ไม่พอ throw 409)
async function assertAvailableWorkerSlots(
  ticketJob: TicketJobDto,
  requestedCount: number,
  transaction: DbConnection,
): Promise<void> {
  const activeAssignmentCount = await assignmentRepository.countActiveAssignments(
    ticketJob.id,
    transaction,
  );
  const availableSlots = Math.max(0, ticketJob.workers_required - activeAssignmentCount);

  if (requestedCount > availableSlots) {
    throw new ApiError(
      409,
      "WORKERS_REQUIRED_EXCEEDED",
      `Vehicle job needs at most ${ticketJob.workers_required} workers; only ${availableSlots} more can be assigned.`,
      {
        workers_required: ticketJob.workers_required,
        active_assignment_count: activeAssignmentCount,
        available_slots: availableSlots,
      },
    );
  }
}

// Function ตรวจเพดานคนของแผงที่ถูกตีกลับ (สมาชิก + คนที่เลือกเข้าแผงต้องไม่เกิน workers_required)
function assertBoothSeatAvailable(
  booth: BoothMembershipRecord,
  addingCount: number,
  workersRequired: number,
): void {
  const seats = countBoothSeats(booth);

  if (seats + addingCount > workersRequired) {
    throw new ApiError(
      409,
      "BOOTH_MEMBER_LIMIT_EXCEEDED",
      `Booth ${booth.booth_code} already has ${seats} of ${workersRequired} workers.`,
      { ticketNo: booth.ticket_no, boothCode: booth.booth_code, seats, workers_required: workersRequired },
    );
  }
}

// Function หาแผงของรถตาม TicketNo + BoothCode (แผงที่ถูกยกเลิกแล้วใช้ไม่ได้)
function requireMembershipBooth(
  booths: BoothMembershipRecord[],
  ticketNo: string,
  boothCode: string,
): BoothMembershipRecord {
  const booth = booths.find(
    (candidate) => candidate.ticket_no === ticketNo && candidate.booth_code === boothCode,
  );

  if (!booth) {
    throw new ApiError(
      409,
      "BOOTH_NOT_AVAILABLE",
      "Booth was not found on this vehicle job or is already cancelled.",
      { ticketNo, boothCode },
    );
  }

  return booth;
}

// Function ตั้งเวลา และแจ้ง worker ที่ Admin เพิ่มเข้างานรถ (best-effort หลัง commit)
async function notifyManualAssignments(
  ticketJob: TicketJobDto,
  assignments: TicketJobAssignmentDto[],
  acceptDeadlineMs: number,
): Promise<void> {
  // แจ้ง Driver Web ว่ามี assignment ใหม่
  publishDriverJobUpdate(ticketJob.id, "DRIVER_JOB_UPDATED");

  let tickets: Array<{ ticket_no: string; created_at: string }> = [];

  try {
    tickets = await marketJobRepository.listActiveTicketSummariesByTicketJobId(ticketJob.id);
  } catch (error) {
    logger.error("Failed to load active ticket numbers after manual worker assignment.", {
      ticketJobId: ticketJob.id,
      error,
    });
  }

  for (const assignment of assignments) {
    try {
      await markWorkerAssigned(assignment.worker_id);
      await scheduleAssignmentTimeout(assignment.id, assignment.worker_id, acceptDeadlineMs);
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
}

// Function แจ้งทีมบนรถว่าต้องรอคนที่เพิ่มเข้ามา scan ก่อนส่งยอดแผงที่ยังไม่ส่ง (ทีมเริ่มงานไปแล้วเท่านั้น)
async function notifyTeamWaitingReplacement(
  ticketJob: TicketJobDto,
  workerCodes: string[],
): Promise<void> {
  if (!ticketJob.work_started_at || workerCodes.length === 0) {
    return;
  }

  publishRealtimeEvent({
    type: "TEAM_WAITING_REPLACEMENT",
    title: "Waiting for a new team member",
    message: `New worker(s) joined vehicle job ${ticketJob.ticket_number}. Booths they join can be submitted after they scan in.`,
    worker_payload: {
      ticketNumber: ticketJob.ticket_number,
      worker_codes: workerCodes,
    },
    worker_ids: await listTicketJobWorkerIds(ticketJob.id),
  });
}

// Function ให้ Admin เพิ่ม worker ใหม่เข้างานรถ (ไม่เกิน workers_required) ทุกคนต้องมีงานอย่างน้อย 1 แผง
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
  const boothMemberships = input.booth_memberships ?? [];
  const settings = await getRuntimeSettings();
  const acceptDeadlineMs = settings.worker_accept_deadline_seconds * 1000;

  const unknownMembershipWorker = boothMemberships.find(
    (membership) => !workerCodes.includes(membership.worker_code),
  );

  if (unknownMembershipWorker) {
    throw new ApiError(
      400,
      "INVALID_BOOTH_MEMBERSHIP",
      `Worker ${unknownMembershipWorker.worker_code} in booth_memberships is not in worker_codes.`,
    );
  }

  const claimedWorkerIds: number[] = [];
  const { assignments, ticketJob } = await withTransaction(async (transaction) => {
    // lock รถก่อนนับคน กันเพิ่มคนพร้อมกันจนเกิน workers_required
    await transaction.$queryRaw`SELECT id FROM ticket_jobs WHERE id = ${ticketJobId} FOR UPDATE`;

    const ticketJob = await requireTicketJobById(ticketJobId, transaction);

    if (TERMINAL_JOB_STATUSES.includes(ticketJob.status)) {
      throw new ApiError(409, "VEHICLE_JOB_CLOSED", "Vehicle job is already closed.");
    }

    await assertAvailableWorkerSlots(ticketJob, workerCodes.length, transaction);

    const booths = await boothJobRepository.listBoothMembershipRecords({ ticketJobId }, transaction);

    // ทุกแผงส่งยอดแล้ว (รอยืนยัน/ยืนยันแล้ว) = คนใหม่จะได้แค่ส่วนแบ่ง ห้ามเพิ่ม
    if (booths.length > 0 && !booths.some((booth) => UNFINISHED_BOOTH_STATUSES.includes(booth.status))) {
      throw new ApiError(
        409,
        "NO_UNFINISHED_BOOTH",
        "Workers can only be added while a booth is still waiting, working or rejected.",
      );
    }

    // ตรวจแผงที่เลือกให้คนใหม่ก่อนสร้าง assignment: ต้องเป็นแผงที่ถูกตีกลับ และไม่เกิน workers_required ต่อแผง
    const pickedBooths = new Map<number, { booth: BoothMembershipRecord; workerCodes: string[] }>();

    for (const membership of boothMemberships) {
      const booth = requireMembershipBooth(booths, membership.ticket_no, membership.boothCode);

      if (booth.status !== TICKET_STATUS.REJECT) {
        throw new ApiError(
          409,
          "BOOTH_NOT_REJECTED",
          "New workers can only be picked into a booth the vendor rejected.",
          { ticketNo: booth.ticket_no, boothCode: booth.booth_code },
        );
      }

      const picked = pickedBooths.get(booth.id) ?? { booth, workerCodes: [] };

      picked.workerCodes.push(membership.worker_code);
      pickedBooths.set(booth.id, picked);
    }

    for (const { booth, workerCodes: pickedCodes } of pickedBooths.values()) {
      assertBoothSeatAvailable(booth, new Set(pickedCodes).size, ticketJob.workers_required);
    }

    // ไม่มีแผงที่ยังไม่ส่งยอดแล้ว คนใหม่ได้งานเฉพาะแผงที่ถูกตีกลับที่ Admin เลือกให้ ทุกคนต้องถูกเลือกอย่างน้อย 1 แผง
    if (booths.length > 0 && !booths.some((booth) => OPEN_BOOTH_STATUSES.includes(booth.status))) {
      const pickedWorkerCodes = new Set(boothMemberships.map((membership) => membership.worker_code));
      const workersWithoutBooth = workerCodes.filter((workerCode) => !pickedWorkerCodes.has(workerCode));

      if (workersWithoutBooth.length > 0) {
        throw new ApiError(
          409,
          "WORKER_BOOTH_REQUIRED",
          "Every new worker must be picked into at least one booth because only rejected booths are left.",
          {
            worker_codes: workersWithoutBooth,
            available_booths: booths
              .filter((booth) => booth.status === TICKET_STATUS.REJECT)
              .map((booth) => ({
                ticket_no: booth.ticket_no,
                boothCode: booth.booth_code,
                remaining_seats: Math.max(0, ticketJob.workers_required - countBoothSeats(booth)),
              })),
          },
        );
      }
    }

    // ช่องที่ว่างจากการถอดคนหรือ Gate เพิ่มคนหลังทีมเริ่มงาน = คนที่เพิ่มเข้ามาเติมช่องนั้น
    let unfilledSlots = ticketJob.unfilled_slot_count;
    const createdAssignments: TicketJobAssignmentDto[] = [];
    const workerIdByCode = new Map<string, number>();

    for (const workerCode of workerCodes) {
      const worker = await adminJobsRepository.findWorkerByCode(workerCode, transaction);

      if (!worker) {
        throw new ApiError(404, "WORKER_NOT_FOUND", `Worker ${workerCode} not found.`);
      }

      // คนที่เคยทำงานบนรถนี้ต้องนำกลับผ่านการจัดสมาชิกแผง (ได้สิทธิ์เดิมคืน)
      if (booths.some((booth) => booth.roster.some((member) => member.worker_id === worker.id))) {
        throw new ApiError(
          409,
          "WORKER_PREVIOUSLY_ON_VEHICLE",
          `Worker ${workerCode} already worked on this vehicle job. Add them back to booths instead.`,
        );
      }

      createdAssignments.push(
        await createManualAssignmentInTransaction(
          ticketJobId,
          worker,
          acceptDeadlineMs,
          unfilledSlots-- > 0,
          claimedWorkerIds,
          transaction,
        ),
      );
      workerIdByCode.set(workerCode, worker.id);
    }

    for (const { booth, workerCodes: pickedCodes } of pickedBooths.values()) {
      for (const pickedCode of new Set(pickedCodes)) {
        await boothJobRepository.createBoothJobWorkerInclusion(
          booth.id,
          workerIdByCode.get(pickedCode) ?? 0,
          transaction,
        );
      }
    }

    await adminActionLogRepository.create(
      {
        vehicle_job_id: ticketJobId,
        action_type: ADMIN_ACTION_TYPE.MANUAL_ASSIGNMENT,
        reason_code: input.reason_code,
        reason_text: input.reason_text,
        actor_account_id: actorId,
        metadata: {
          source: "manual_assign",
          assignment_ids: createdAssignments.map((assignment) => assignment.id),
          worker_ids: createdAssignments.map((assignment) => assignment.worker_id),
          worker_codes: workerCodes,
          fills_removed_slot_assignment_ids: createdAssignments
            .filter((assignment) => assignment.fills_removed_slot)
            .map((assignment) => assignment.id),
          booth_memberships: boothMemberships,
        },
      },
      transaction,
    );

    return { assignments: createdAssignments, ticketJob };
  }).catch((error) => restoreClaimedWorkers(claimedWorkerIds, error));

  await notifyManualAssignments(ticketJob, assignments, acceptDeadlineMs);
  await notifyTeamWaitingReplacement(ticketJob, workerCodes);

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

// Function นำ worker เข้าแผงที่เลือก (คืนสิทธิ์คนที่ถูกถอด หรือเลือกเข้าแผงที่ถูกตีกลับ) ต้องผ่านทุกแผงในคำขอ
export async function addWorkerToBooths(
  ticketNumberParam: unknown,
  workerCodeParam: unknown,
  body: unknown,
  auth?: AccessTokenPayload,
): Promise<AdminAddWorkerToBoothsResponse> {
  const ticketJob = await requireTicketJobByRef(ticketNumberParam);
  const workerCode = parseRequiredReference(
    workerCodeParam,
    "INVALID_WORKER_CODE",
    "Worker code is invalid.",
  );
  const input = parseWithSchema(adminAddWorkerToBoothsBodySchema, body);
  const actorId = requireActorId(auth);
  const settings = await getRuntimeSettings();
  const acceptDeadlineMs = settings.worker_accept_deadline_seconds * 1000;
  const worker = await adminJobsRepository.findWorkerByCode(workerCode);

  if (!worker) {
    throw new ApiError(404, "WORKER_NOT_FOUND", `Worker ${workerCode} not found.`);
  }

  const claimedWorkerIds: number[] = [];
  const result = await withTransaction(async (transaction) => {
    // lock ตามลำดับมาตรฐาน: งานรถก่อน แล้วค่อยแผงทุกแผงของรถ
    await ticketJobRepository.lockTicketJob(ticketJob.id, transaction);
    await transaction.$queryRaw`SELECT id FROM booth_jobs WHERE ticket_job_id = ${ticketJob.id} ORDER BY id FOR UPDATE`;

    const currentTicketJob = await requireTicketJobById(ticketJob.id, transaction);

    await assertWorkerRemovalWindow(currentTicketJob, worker.id, transaction);

    const booths = await boothJobRepository.listBoothMembershipRecords(
      { ticketJobId: ticketJob.id },
      transaction,
    );
    const targets = [
      ...new Map(
        input.booths
          .map((target) => requireMembershipBooth(booths, target.ticket_no, target.boothCode))
          .map((booth) => [booth.id, booth]),
      ).values(),
    ];
    const outcomes: AdminBoothMembershipResult[] = [];
    const recalculations: BoothRemovalOutcome[] = [];
    const revivedMarketJobIds = new Set<number>();
    let needsActiveWork = false;

    // แผงที่จบแล้วคืนเงินทันทีไม่ต้อง scan ส่วนแผงที่ยังไม่จบ worker ต้องมีงานบนรถ (ไม่มีจะสร้าง assignment ใหม่)
    for (const booth of targets) {
      const ticketWorkerId = findBoothTicketWorkerId(booth, worker.id);
      const memberIds = resolveBoothMemberTicketWorkerIds(booth);
      const isExcluded =
        ticketWorkerId !== null && booth.excluded_ticket_worker_ids.includes(ticketWorkerId);

      if (ticketWorkerId !== null && memberIds.includes(ticketWorkerId)) {
        throw new ApiError(
          409,
          "WORKER_ALREADY_IN_BOOTH",
          `Worker ${workerCode} is already a member of booth ${booth.booth_code}.`,
          { ticketNo: booth.ticket_no, boothCode: booth.booth_code },
        );
      }

      if (MIN_ONE_WORKER_BOOTH_STATUSES.includes(booth.status)) {
        // แผงที่ส่งยอดแล้ว นำกลับได้เฉพาะคนที่เคยอยู่ในรายชื่อส่งยอดแล้วถูกถอดออก
        const listedAtSubmit =
          ticketWorkerId !== null &&
          (booth.latest_submission?.snapshot_ticket_worker_ids.includes(ticketWorkerId) ||
            booth.booth_snapshot_ticket_worker_ids.includes(ticketWorkerId));

        if (ticketWorkerId === null || !isExcluded || !listedAtSubmit) {
          throw new ApiError(
            409,
            "BOOTH_MEMBER_NOT_RESTORABLE",
            "Only a worker who was listed when the booth was submitted and later removed can be added back to it.",
            { ticketNo: booth.ticket_no, boothCode: booth.booth_code },
          );
        }

        await boothJobRepository.deleteBoothJobWorkerExclusion(booth.id, ticketWorkerId, transaction);

        // ถูกถอดก่อน Vendor ยืนยัน = ไม่อยู่ใน snapshot ตอนยืนยัน ต้องเพิ่มกลับ
        if (
          booth.status === TICKET_STATUS.COMPLETED &&
          !booth.booth_snapshot_ticket_worker_ids.includes(ticketWorkerId)
        ) {
          await boothJobRepository.createBoothJobWorkerSnapshot(booth.id, ticketWorkerId, transaction);
        }

        const recalculation =
          booth.status === TICKET_STATUS.COMPLETED
            ? await ticketFinancialService.refinalizeBoothWorkerPayments(
              booth.market_job_id,
              booth.id,
              transaction,
            )
            : null;

        recalculations.push({
          booth,
          paid: true,
          memberIdsBefore: memberIds,
          memberIdsAfter: [...memberIds, ticketWorkerId],
          recalculation,
          cancelledBooth: null,
        });
        outcomes.push({ ticket_no: booth.ticket_no, boothCode: booth.booth_code, booth_status: booth.status, action: "restored" });
        continue;
      }

      needsActiveWork = true;
      revivedMarketJobIds.add(booth.market_job_id);

      if (booth.status === TICKET_STATUS.REJECT) {
        assertBoothSeatAvailable(booth, 1, currentTicketJob.workers_required);
      }

      const listedAtSubmit =
        ticketWorkerId !== null &&
        (booth.latest_submission?.snapshot_ticket_worker_ids.includes(ticketWorkerId) ?? false);

      if (isExcluded && ticketWorkerId !== null && (booth.status !== TICKET_STATUS.REJECT || listedAtSubmit)) {
        await boothJobRepository.deleteBoothJobWorkerExclusion(booth.id, ticketWorkerId, transaction);
        outcomes.push({ ticket_no: booth.ticket_no, boothCode: booth.booth_code, booth_status: booth.status, action: "restored" });
      } else {
        // แผงที่ยังไม่ส่งยอด สมาชิกคือทุกคนใน roster จึงไม่ต้องบันทึกเพิ่ม ส่วนแผงที่ถูกตีกลับต้องบันทึกว่าเลือกเข้าแผง
        if (booth.status === TICKET_STATUS.REJECT) {
          await boothJobRepository.createBoothJobWorkerInclusion(booth.id, worker.id, transaction);
        }

        outcomes.push({ ticket_no: booth.ticket_no, boothCode: booth.booth_code, booth_status: booth.status, action: "included" });
      }
    }

    let createdAssignment: TicketJobAssignmentDto | null = null;

    if (needsActiveWork) {
      const activeAssignment = await assignmentRepository.findLatestAssignmentByTicketJobIdAndWorker(
        ticketJob.id,
        worker.id,
        ACTIVE_ASSIGNMENT_STATUSES,
        transaction,
      );

      if (!activeAssignment) {
        await assertAvailableWorkerSlots(currentTicketJob, 1, transaction);
        createdAssignment = await createManualAssignmentInTransaction(
          ticketJob.id,
          worker,
          acceptDeadlineMs,
          currentTicketJob.unfilled_slot_count > 0,
          claimedWorkerIds,
          transaction,
        );
      }

      // นำกลับเข้า roster ของใบที่เลือก และถอดออกจากแผงที่ยังไม่ส่งยอดซึ่ง Admin ไม่ได้เลือก
      const targetIds = new Set(targets.map((booth) => booth.id));

      for (const marketJobId of revivedMarketJobIds) {
        await ticketWorkerRepository.reviveTicketWorker(marketJobId, worker.id, transaction);

        for (const booth of booths) {
          const ticketWorkerId = findBoothTicketWorkerId(booth, worker.id);

          if (
            booth.market_job_id === marketJobId &&
            !targetIds.has(booth.id) &&
            !PAYOUT_SNAPSHOT_BOOTH_STATUSES.includes(booth.status) &&
            ticketWorkerId !== null &&
            !booth.excluded_ticket_worker_ids.includes(ticketWorkerId)
          ) {
            await boothJobRepository.createBoothJobWorkerExclusion(booth.id, ticketWorkerId, transaction);
          }
        }
      }
    }

    await adminActionLogRepository.create(
      {
        vehicle_job_id: ticketJob.id,
        action_type: ADMIN_ACTION_TYPE.BOOTH_MEMBERS_ADDED,
        reason_code: input.reason_code,
        reason_text: input.reason_text,
        actor_account_id: actorId,
        metadata: {
          worker_id: worker.id,
          worker_code: workerCode,
          booths: outcomes,
          assignment_id: createdAssignment?.id ?? null,
          payout_recalculations: recalculations
            .filter((item) => item.recalculation)
            .map((item) => item.recalculation),
        },
      },
      transaction,
    );

    return { outcomes, recalculations, createdAssignment, currentTicketJob };
  }).catch((error) => restoreClaimedWorkers(claimedWorkerIds, error));

  if (result.createdAssignment) {
    await notifyManualAssignments(result.currentTicketJob, [result.createdAssignment], acceptDeadlineMs);
    await notifyTeamWaitingReplacement(result.currentTicketJob, [workerCode]);
  }

  await publishBoothRemovalSideEffects(ticketJob.ticket_number, workerCode, {
    outcomes: result.recalculations,
    completedTicketJob: null,
  });

  publishRealtimeEvent({
    type: "BOOTH_MEMBERS_CHANGED",
    title: "Added back to booths",
    message: `Admin added you to booth(s) on vehicle job ${ticketJob.ticket_number}.`,
    payload: {
      ticketNumber: ticketJob.ticket_number,
      worker_code: workerCode,
      booths: result.outcomes,
    },
    worker_payload: {
      ticketNumber: ticketJob.ticket_number,
      booths: result.outcomes,
      reason_code: input.reason_code,
      reason_text: input.reason_text,
    },
    admin: true,
    worker_ids: [worker.id],
  });

  return {
    message: "Worker added to booths successfully.",
    ticket_number: ticketJob.ticket_number,
    worker_code: workerCode,
    booths: result.outcomes,
    assignment_created: result.createdAssignment !== null,
  };
}

// Type ผลการยกเลิก assignment ใน transaction สำหรับทำงานต่อหลัง commit
type CancelledAssignmentResult = {
  cancelledAssignment: TicketJobAssignmentDto;
  teamScan: VehicleWorkReadinessDto;
  wasTeamReady: boolean;
  replacementNotNeeded: boolean;
};

// Function ยกเลิก assignment ใน transaction ของผู้เรียก (ต้องเรียก finalizeCancelledAssignment หลัง commit)
async function cancelAssignmentInTransaction(
  assignment: TicketJobAssignmentDto,
  workerCode: string,
  reason: AdminActionReason,
  actorId: number,
  transaction: DbConnection,
  extraMetadata?: Record<string, unknown>,
): Promise<CancelledAssignmentResult> {
  // lock assignment ก่อนอ่านสถานะ กัน race กับ worker ที่กำลัง scan
  await transaction.$queryRaw`SELECT id FROM ticket_job_assignments WHERE id = ${assignment.id} FOR UPDATE`;

  const currentAssignment = await assignmentRepository.findAssignmentById(
    assignment.id,
    transaction,
  );
  const wasScanned = Boolean(
    currentAssignment &&
      SCANNED_ASSIGNMENT_STATUSES.includes(currentAssignment.status),
  );
  const teamScanBefore =
    await assignmentRepository.getTicketJobTeamScanReadiness(
      assignment.vehicle_job_id,
      transaction,
    );

  // ยกเลิกเฉพาะ assignment ผู้เรียกถอดออกจากแผงและตรวจคนสุดท้ายบนรถไว้ก่อนแล้ว
  const result = await assignmentRepository.cancelAssignment(
    assignment.id,
    transaction,
  );

  if (!result) {
    // แพ้ race ให้ accept/scan/timeout ไปก่อน throw เพื่อ rollback
    throw new ApiError(
      409,
      "ASSIGNMENT_NOT_ACTIVE",
      "Assignment is not active.",
    );
  }

  // ถอดคนที่ scan แล้ว = ไม่หาคนแทน (นับเพิ่ม unfilled_slot_count) ส่วนคนที่ยังไม่ scan จะหาคนแทนตามปกติ
  const replacementNotNeeded = wasScanned
    ? await ticketJobRepository.incrementTicketJobUnfilledSlotCount(
        assignment.vehicle_job_id,
        transaction,
      )
    : false;

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
      reason_code: reason.reasonCode,
      reason_text: reason.reasonText,
      actor_account_id: actorId,
      metadata: {
        assignment_id: assignment.id,
        worker_id: assignment.worker_id,
        worker_code: workerCode,
        previous_status: currentAssignment?.status ?? null,
        replacement_dispatched: !replacementNotNeeded,
        workers_required: teamScan.workers_required,
        ...(extraMetadata ?? {}),
      },
    },
    transaction,
  );

  return {
    cancelledAssignment: result,
    teamScan,
    wasTeamReady: teamScanBefore.is_ready,
    replacementNotNeeded,
  };
}

// Function ทำงานหลัง commit การยกเลิก assignment (ล้าง timer ย้ายไป open_app แจ้งเตือน และหาคนแทน)
async function finalizeCancelledAssignment(
  assignment: TicketJobAssignmentDto,
  ticketJob: TicketJobDto | null,
  workerCode: string,
  result: CancelledAssignmentResult,
  options: {
    reason: string;
    // ข้อมูลเพิ่มใน payload ของ ASSIGNMENT_CANCELLED ที่ส่งให้ Worker เช่น ticketNo/boothCode ที่ถูกถอดออก
    workerPayload?: Record<string, unknown>;
  },
): Promise<void> {
  const {
    cancelledAssignment,
    teamScan,
    wasTeamReady,
    replacementNotNeeded,
  } = result;

  publishNotification({
    type: "ASSIGNMENT_CANCELLED",
    title: "Assignment cancelled",
    message: `Assignment for ${workerCode} on ${ticketJob?.ticket_number ?? "-"} was cancelled by admin.`,
    payload: {
      ticketNumber: ticketJob?.ticket_number ?? null,
      worker_code: workerCode,
      status: cancelledAssignment.status,
      reason: options.reason,
      replacement_dispatched: !replacementNotNeeded,
    },
    audience: {
      roles: ["admin"],
    },
  });

  // แจ้ง Driver Web ว่า assignment ถูกยกเลิก — เรียกหลัง transaction ของ caller commit สำเร็จแล้วเท่านั้น
  publishDriverJobUpdate(assignment.vehicle_job_id, "DRIVER_JOB_UPDATED");

  await removeAssignmentTimeout(assignment.id);
  await removeScanTimeout(assignment.id);
  await removeScanWarning(assignment.id);
  const queue = await markWorkerOpenApp(
    assignment.worker_id,
    WORKER_OPEN_APP_REASON.ADMIN_CANCEL_ASSIGNMENT,
  );
  const ticketNos = await marketJobRepository.listActiveTicketNosByTicketJobId(
    assignment.vehicle_job_id,
  );

  // แนบสถานะคิวไปด้วยให้แอปอัปเดตได้จาก event เดียว
  sendWorkerSocketEvent(assignment.worker_id, "ASSIGNMENT_CANCELLED", {
    ticketNumber: ticketJob?.ticket_number ?? null,
    ticketNos,
    ...(options.workerPayload ?? {}),
    reason: options.reason,
    worker_status: WORKER_WORK_STATUS.OPEN_APP,
    queue: buildWorkerQueueSocketPayload(queue, workerCode),
  });
  // แจ้ง Admin ให้ตารางสถานะ worker อัปเดต
  publishAdminWorkerStatusChanged({
    title: "Worker moved to open_app",
    message: `Worker ${workerCode} moved to open_app after admin cancelled the assignment.`,
    workerCode,
    queue,
    reason: options.reason,
  });

  // แจ้งทีมที่เหลือตามสถานะทีมล่าสุดหลังยกเลิก — ไม่ประกาศ TEAM_READY (มี push) ซ้ำถ้าทีมพร้อมทำงานอยู่ก่อนแล้ว
  if (ticketJob) {
    await notifyTicketJobTeamScanReadiness(ticketJob, teamScan, {
      announceReady: !wasTeamReady,
    });
  }

  // หาคนแทนแบบ best-effort (เรียกหลังย้ายไป open_app จึงไม่ได้คนเดิมกลับมา)
  try {
    await dispatchReadyWorkers();
  } catch (error) {
    logger.error("Assignment was cancelled but replacement dispatch failed.", {
      ticketJobId: assignment.vehicle_job_id,
      error,
    });
  }
}

// Type คำขอถอด worker ที่ parse จาก body แล้ว (booth_payouts = สิทธิ์เงินรายแผงที่ Admin เลือก)
type WorkerRemovalRequest = AdminActionReason & {
  boothPayouts: Array<{ ticket_no: string; boothCode: string; paid: boolean }>;
};

// Type ผลการถอด worker ออกจากแผงหนึ่งแผงใน transaction
type BoothRemovalOutcome = {
  booth: BoothMembershipRecord;
  paid: boolean;
  memberIdsBefore: number[];
  memberIdsAfter: number[];
  recalculation: BoothPayoutRecalculation | null;
  cancelledBooth: BoothJobDto | null;
};

// Type ผลรวมการถอด worker ออกจากหลายแผง (completedTicketJob = รถถูกปิดเพราะแผงสุดท้ายถูกยกเลิก)
type BoothRemovalResult = {
  outcomes: BoothRemovalOutcome[];
  completedTicketJob: CompletedTicketJobResult | null;
};

// Config สถานะ assignment ที่ Admin ถอด worker ออกจากงานรถได้ (รวมคนที่ release หรือจบงานแล้ว)
const REMOVABLE_ASSIGNMENT_STATUSES: string[] = [
  ...ACTIVE_ASSIGNMENT_STATUSES,
  ASSIGNMENT_STATUS.RELEASED,
  ASSIGNMENT_STATUS.COMPLETED,
];

// Function ดึงงานรถใน transaction (ไม่พบ throw 404)
async function requireTicketJobById(
  ticketJobId: number,
  transaction: DbConnection,
): Promise<TicketJobDto> {
  const ticketJob = await ticketJobRepository.findTicketJobById(ticketJobId, transaction);

  if (!ticketJob) {
    throw new ApiError(404, "VEHICLE_JOB_NOT_FOUND", "Vehicle job not found.");
  }

  return ticketJob;
}

// Function ตรวจว่ายังถอดหรือนำ worker กลับได้ (งานรถยังไม่ปิด หรือยังอยู่ในกะของ worker คนนั้น)
async function assertWorkerRemovalWindow(
  ticketJob: TicketJobDto,
  workerId: number,
  transaction: DbConnection,
): Promise<void> {
  if (!TERMINAL_JOB_STATUSES.includes(ticketJob.status)) {
    return;
  }

  const workerSchedule = await workScheduleRepository.findCurrentByAccountId(workerId, transaction);

  if (workerSchedule && isTimeInWorkSchedule(workerSchedule)) {
    return;
  }

  throw new ApiError(
    409,
    "REMOVAL_WINDOW_CLOSED",
    "Worker can only be changed while the vehicle job is open or within the worker's shift.",
  );
}

// Function ตรวจว่าการถอดคนที่ scan แล้วไม่ทำให้รถไม่เหลือคนทำงาน (คนที่ยังไม่ scan ระบบหาคนแทนให้เอง จึงไม่ต้องตรวจ)
async function assertNotLastActiveWorker(
  assignment: TicketJobAssignmentDto,
  transaction: DbConnection,
): Promise<void> {
  if (!SCANNED_ASSIGNMENT_STATUSES.includes(assignment.status)) {
    return;
  }

  const ticketJobId = assignment.vehicle_job_id;
  const activeAssignmentCount = await assignmentRepository.countActiveAssignments(
    ticketJobId,
    transaction,
  );

  if (activeAssignmentCount <= 1) {
    throw new ApiError(
      409,
      "LAST_WORKER_ON_VEHICLE",
      "Removing this worker would leave the vehicle job without workers. Add a replacement first or cancel the vehicle job.",
    );
  }
}

// Function ดึงแผงที่ worker มีชื่อในรายชื่อส่งยอด (Admin เลือกให้เงิน/ไม่ให้เงินได้)
function listWorkerPayoutBooths(
  booths: BoothMembershipRecord[],
  workerId: number,
): BoothMembershipRecord[] {
  return booths.filter((booth) => {
    const ticketWorkerId = findBoothTicketWorkerId(booth, workerId);

    return (
      ticketWorkerId !== null &&
      PAYOUT_SNAPSHOT_BOOTH_STATUSES.includes(booth.status) &&
      resolveBoothMemberTicketWorkerIds(booth).includes(ticketWorkerId)
    );
  });
}

// Function หาแผงที่ไม่ให้เงิน = แผงที่ Admin เลือกไม่ให้เงิน + แผงที่ยังไม่ส่งยอด
function resolveUnpaidBoothIds(
  booths: BoothMembershipRecord[],
  payoutBooths: BoothMembershipRecord[],
  boothPayouts: WorkerRemovalRequest["boothPayouts"],
): Set<number> {
  const unpaidBoothIds = new Set(
    booths
      .filter((booth) => !PAYOUT_SNAPSHOT_BOOTH_STATUSES.includes(booth.status))
      .map((booth) => booth.id),
  );

  for (const choice of boothPayouts) {
    const booth = payoutBooths.find(
      (candidate) =>
        candidate.ticket_no === choice.ticket_no && candidate.booth_code === choice.boothCode,
    );

    if (!booth) {
      throw new ApiError(
        409,
        "BOOTH_PAYOUT_NOT_ELIGIBLE",
        "Payout can only be chosen for a submitted booth that lists this worker.",
        { ticketNo: choice.ticket_no, boothCode: choice.boothCode },
      );
    }

    if (!choice.paid) {
      unpaidBoothIds.add(booth.id);
    }
  }

  return unpaidBoothIds;
}

// Function ถอด worker ออกจากแผงที่ไม่ให้เงิน คิดเงินแผงที่ปิดยอดแล้วใหม่ และยกเลิกแผงที่ไม่เหลือคน
async function removeWorkerFromBooths(input: {
  booths: BoothMembershipRecord[];
  workerId: number;
  workerCode: string;
  unpaidBoothIds: Set<number>;
  reason: AdminActionReason;
  actorId: number;
  transaction: DbConnection;
}): Promise<BoothRemovalResult> {
  const outcomes: BoothRemovalOutcome[] = [];
  let completedTicketJob: CompletedTicketJobResult | null = null;

  for (const booth of input.booths) {
    const ticketWorkerId = findBoothTicketWorkerId(booth, input.workerId);
    const memberIdsBefore = resolveBoothMemberTicketWorkerIds(booth);

    if (ticketWorkerId === null || !memberIdsBefore.includes(ticketWorkerId)) {
      continue;
    }

    if (!input.unpaidBoothIds.has(booth.id)) {
      outcomes.push({
        booth,
        paid: true,
        memberIdsBefore,
        memberIdsAfter: memberIdsBefore,
        recalculation: null,
        cancelledBooth: null,
      });
      continue;
    }

    const memberIdsAfter = memberIdsBefore.filter((id) => id !== ticketWorkerId);
    const mustKeepOneWorker = MIN_ONE_WORKER_BOOTH_STATUSES.includes(booth.status);

    if (mustKeepOneWorker && memberIdsAfter.length === 0) {
      throw new ApiError(
        409,
        "BOOTH_MIN_ONE_WORKER",
        "A submitted or confirmed booth must keep at least one paid worker.",
        { ticketNo: booth.ticket_no, boothCode: booth.booth_code },
      );
    }

    await boothJobRepository.createBoothJobWorkerExclusion(
      booth.id,
      ticketWorkerId,
      input.transaction,
    );

    const recalculation =
      booth.status === TICKET_STATUS.COMPLETED
        ? await ticketFinancialService.refinalizeBoothWorkerPayments(
          booth.market_job_id,
          booth.id,
          input.transaction,
        )
        : null;
    let cancelledBooth: BoothJobDto | null = null;

    if (!mustKeepOneWorker && memberIdsAfter.length === 0) {
      const boothJob = await boothJobRepository.findBoothJobForCompletion(booth.id, input.transaction);

      if (!boothJob) {
        throw new ApiError(404, "STALL_JOB_NOT_FOUND", "Stall job not found.");
      }

      const cancelled = await cancelStallJobRecord(
        boothJob,
        input.reason,
        input.actorId,
        input.transaction,
        {
          source: "auto_cancel_last_worker_excluded",
          triggered_by_worker_code: input.workerCode,
          snapshot_ticket_worker_ids: memberIdsBefore,
        },
      );

      // แผงที่ไม่เหลือคนถูกยกเลิกได้ แต่ห้ามทำให้ทั้งรถถูกยกเลิกจากการถอดคน
      if (cancelled.completedTicketJob?.vehicle_job.status === VEHICLE_JOB_STATUS.CANCELLED) {
        throw new ApiError(
          409,
          "LAST_WORKER_ON_VEHICLE",
          "Removing this worker would cancel the whole vehicle job. Add a replacement first or cancel the vehicle job.",
        );
      }

      cancelledBooth = cancelled.ticket;
      completedTicketJob = cancelled.completedTicketJob ?? completedTicketJob;
    }

    outcomes.push({
      booth,
      paid: false,
      memberIdsBefore,
      memberIdsAfter,
      recalculation,
      cancelledBooth,
    });
  }

  return { outcomes, completedTicketJob };
}

// Function แปลงผลถอดรายแผงเป็นข้อมูล audit (รายชื่อก่อน/หลัง ยอดเงินก่อน/หลัง และแผงที่ถูกยกเลิก)
function formatBoothRemovalAudit(outcomes: BoothRemovalOutcome[]) {
  return outcomes.map((outcome) => ({
    ticket_no: outcome.booth.ticket_no,
    booth_code: outcome.booth.booth_code,
    booth_status: outcome.booth.status,
    paid: outcome.paid,
    member_ticket_worker_ids_before: outcome.memberIdsBefore,
    member_ticket_worker_ids_after: outcome.memberIdsAfter,
    booth_cancelled: outcome.cancelledBooth !== null,
    payout_recalculation: outcome.recalculation,
  }));
}

// Function แปลงผลถอดรายแผงเป็น response ให้ Admin UI (เฉพาะแผงที่มีรายชื่อส่งยอด ตรงกับที่ Admin เลือกสิทธิ์เงิน)
function formatBoothPayoutResults(outcomes: BoothRemovalOutcome[]): AdminBoothPayoutResult[] {
  return outcomes
    .filter((outcome) => PAYOUT_SNAPSHOT_BOOTH_STATUSES.includes(outcome.booth.status))
    .map((outcome) => ({
      ticket_no: outcome.booth.ticket_no,
      boothCode: outcome.booth.booth_code,
      booth_status: outcome.booth.status,
      paid: outcome.paid,
      booth_cancelled: outcome.cancelledBooth !== null,
    }));
}

// Function ทำงานหลัง commit การถอดรายแผง (แจ้ง Admin เมื่อคิดเงินใหม่ และแจ้งแผงที่ถูกยกเลิกอัตโนมัติ)
async function publishBoothRemovalSideEffects(
  ticketNumber: string,
  workerCode: string,
  removal: BoothRemovalResult,
): Promise<void> {
  for (const outcome of removal.outcomes) {
    if (outcome.recalculation) {
      publishNotification({
        type: "WORKER_PAYOUT_RECALCULATED",
        title: "Worker payout recalculated",
        message: `Payout of booth ${outcome.booth.booth_code} was recalculated after ${workerCode} was removed.`,
        payload: {
          ticketNumber,
          ticketNo: outcome.booth.ticket_no,
          boothCode: outcome.booth.booth_code,
          worker_code: workerCode,
          recalculation: outcome.recalculation,
        },
        audience: {
          roles: ["admin"],
        },
      });
    }
  }

  const cancelledBooths = removal.outcomes
    .map((outcome) => outcome.cancelledBooth)
    .filter((booth): booth is BoothJobDto => booth !== null);

  for (const [index, booth] of cancelledBooths.entries()) {
    // ส่งผลปิดรถครั้งเดียวกับแผงสุดท้าย กันคืนคิวซ้ำ
    await publishStallJobCancelledSideEffects(
      booth,
      index === cancelledBooths.length - 1 ? removal.completedTicketJob : null,
    );
  }
}

// Function ดึงสิทธิ์เงินรายแผงของ worker ก่อนถอด (ใส่ ticket_no = เฉพาะ Business Ticket นั้น)
export async function getWorkerPayoutPreview(
  ticketNumberParam: unknown,
  workerCodeParam: unknown,
  query: unknown,
): Promise<AdminWorkerPayoutPreviewResponse> {
  const ticketJob = await requireTicketJobByRef(ticketNumberParam);
  const workerCode = parseRequiredReference(
    workerCodeParam,
    "INVALID_WORKER_CODE",
    "Worker code is invalid.",
  );
  const input = parseWithSchema(adminWorkerPayoutPreviewQuerySchema, query ?? {});
  const worker = await adminJobsRepository.findWorkerByCode(workerCode);

  if (!worker) {
    throw new ApiError(404, "WORKER_NOT_FOUND", `Worker ${workerCode} not found.`);
  }

  const assignment = await assignmentRepository.findLatestAssignmentByTicketJobIdAndWorker(
    ticketJob.id,
    worker.id,
    REMOVABLE_ASSIGNMENT_STATUSES,
  );

  if (!assignment) {
    throw new ApiError(404, "ASSIGNMENT_NOT_FOUND", "Assignment not found.");
  }

  let scope: { ticketJobId: number } | { marketJobId: number } = { ticketJobId: ticketJob.id };

  if (input.ticket_no) {
    const marketJob = await marketJobRepository.findMarketJobByVehicleAndTicketNo(
      ticketJob.id,
      input.ticket_no,
    );

    if (!marketJob) {
      throw new ApiError(404, "MARKET_JOB_NOT_FOUND", "Business ticket not found.");
    }

    scope = { marketJobId: marketJob.id };
  }

  const booths = listWorkerPayoutBooths(
    await boothJobRepository.listBoothMembershipRecords(scope),
    worker.id,
  ).map((booth) => {
    const ticketWorkerId = findBoothTicketWorkerId(booth, worker.id) ?? 0;
    const memberCount = resolveBoothMemberTicketWorkerIds(booth).length;
    const remainingIfUnpaid = memberCount - 1;
    const mustKeepOneWorker = MIN_ONE_WORKER_BOOTH_STATUSES.includes(booth.status);
    const amount = estimateBoothWorkerAmount(booth, ticketWorkerId);

    return {
      ticket_no: booth.ticket_no,
      boothCode: booth.booth_code,
      booth_name: booth.booth_name,
      market_name: booth.market_name,
      status: booth.status,
      submitted_at: booth.latest_submission?.created_at ?? null,
      worker_amount: amount?.toFixed(2) ?? null,
      member_count: memberCount,
      remaining_if_unpaid: remainingIfUnpaid,
      can_set_unpaid: !mustKeepOneWorker || remainingIfUnpaid > 0,
      cancels_booth_if_unpaid: !mustKeepOneWorker && remainingIfUnpaid === 0,
    };
  });
  const currentTotal = booths.reduce(
    (total, booth) => total.plus(booth.worker_amount ?? 0),
    new Prisma.Decimal(0),
  );

  return {
    ticket_number: ticketJob.ticket_number,
    vehicle_status: ticketJob.status,
    worker_code: workerCode,
    worker_name: worker.full_name ?? worker.name,
    assignment_status: assignment.status,
    booths,
    current_total: currentTotal.toFixed(2),
    pending_booth_count: booths.filter((booth) => booth.worker_amount === null).length,
  };
}

// Function ถอด worker ออกจากงานรถ พร้อมเลือกให้เงิน/ไม่ให้เงินรายแผงที่ส่งยอดแล้ว (ถอดคนที่ release หรือจบงานแล้วได้)
async function cancelAssignment(
  ticketNumber: string,
  workerCode: string,
  request: WorkerRemovalRequest,
  auth?: AccessTokenPayload,
): Promise<AdminCancelAssignmentResponse> {
  const actorId = requireActorId(auth);
  const ticketJob = await requireTicketJobByRef(ticketNumber);
  const worker = await adminJobsRepository.findWorkerByCode(workerCode);

  if (!worker) {
    throw new ApiError(404, "WORKER_NOT_FOUND", `Worker ${workerCode} not found.`);
  }

  const result = await withTransaction(async (transaction) => {
    // lock งานรถก่อนตามลำดับมาตรฐาน (Vendor ยืนยันก็ lock งานรถก่อน) แล้วค่อยแผงทุกแผง
    await ticketJobRepository.lockTicketJob(ticketJob.id, transaction);
    await transaction.$queryRaw`SELECT id FROM booth_jobs WHERE ticket_job_id = ${ticketJob.id} ORDER BY id FOR UPDATE`;

    const assignment = await assignmentRepository.findLatestAssignmentByTicketJobIdAndWorker(
      ticketJob.id,
      worker.id,
      REMOVABLE_ASSIGNMENT_STATUSES,
      transaction,
    );

    if (!assignment) {
      throw new ApiError(404, "ASSIGNMENT_NOT_FOUND", "Assignment not found.");
    }

    const currentTicketJob = await requireTicketJobById(ticketJob.id, transaction);
    const isActive = ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status);

    await assertWorkerRemovalWindow(currentTicketJob, worker.id, transaction);

    if (isActive) {
      await assertNotLastActiveWorker(assignment, transaction);
    }

    const booths = await boothJobRepository.listBoothMembershipRecords(
      { ticketJobId: ticketJob.id },
      transaction,
    );
    const removal = await removeWorkerFromBooths({
      booths,
      workerId: worker.id,
      workerCode,
      unpaidBoothIds: resolveUnpaidBoothIds(
        booths,
        listWorkerPayoutBooths(booths, worker.id),
        request.boothPayouts,
      ),
      reason: request,
      actorId,
      transaction,
    });
    const boothPayouts = formatBoothRemovalAudit(removal.outcomes);

    // assignment ยังทำงานอยู่และรถยังไม่ปิด = ยกเลิก assignment และคืน open_app (หาคนแทนถ้ายังไม่ scan)
    if (isActive && !removal.completedTicketJob) {
      const cancelled = await cancelAssignmentInTransaction(
        assignment,
        workerCode,
        request,
        actorId,
        transaction,
        { booth_payouts: boothPayouts },
      );

      return { assignment, removal, cancelled, finishedStatus: cancelled.cancelledAssignment.status };
    }

    // คน release แล้ว หรือรถปิดแล้ว: รถยังเปิดยกเลิกเสมอ รถปิดแล้วยกเลิกเฉพาะเมื่อไม่เหลือแผงที่ได้เงิน
    const latest =
      (await assignmentRepository.findAssignmentById(assignment.id, transaction)) ?? assignment;
    const keepsPaidBooth = removal.outcomes.some((outcome) => outcome.paid);
    const shouldCancel = latest.status === ASSIGNMENT_STATUS.RELEASED || !keepsPaidBooth;
    const cancelledFinished = shouldCancel
      ? await assignmentRepository.cancelFinishedAssignment(latest.id, transaction)
      : null;

    await adminActionLogRepository.create(
      {
        vehicle_job_id: ticketJob.id,
        action_type: ADMIN_ACTION_TYPE.ASSIGNMENT_CANCELLED,
        reason_code: request.reasonCode,
        reason_text: request.reasonText,
        actor_account_id: actorId,
        metadata: {
          assignment_id: assignment.id,
          worker_id: worker.id,
          worker_code: workerCode,
          previous_status: latest.status,
          replacement_dispatched: false,
          booth_payouts: boothPayouts,
        },
      },
      transaction,
    );

    return {
      assignment,
      removal,
      cancelled: null,
      finishedStatus: cancelledFinished?.status ?? latest.status,
    };
  });

  if (result.cancelled) {
    await finalizeCancelledAssignment(result.assignment, ticketJob, workerCode, result.cancelled, {
      reason: "admin_cancel_assignment",
      workerPayload: {
        reason_code: request.reasonCode,
        reason_text: request.reasonText,
      },
    });
  } else {
    // คนที่ออกจากรถไปแล้วอาจกำลังทำงานคันอื่น จึงแจ้งแบบไม่แตะสถานะคิว
    publishRealtimeEvent({
      type: "WORKER_REMOVED_FROM_VEHICLE_JOB",
      title: "Removed from vehicle job",
      message: `Admin removed you from vehicle job ${ticketJob.ticket_number}.`,
      worker_payload: {
        ticketNumber: ticketJob.ticket_number,
        booth_payouts: formatBoothPayoutResults(result.removal.outcomes),
        reason_code: request.reasonCode,
        reason_text: request.reasonText,
      },
      worker_ids: [worker.id],
    });
    publishNotification({
      type: "ASSIGNMENT_CANCELLED",
      title: "Assignment cancelled",
      message: `${workerCode} was removed from ${ticketJob.ticket_number} by admin after the team was released.`,
      payload: {
        ticketNumber: ticketJob.ticket_number,
        worker_code: workerCode,
        status: result.finishedStatus,
        reason: "admin_remove_after_release",
        replacement_dispatched: false,
      },
      audience: {
        roles: ["admin"],
      },
    });
  }

  await publishBoothRemovalSideEffects(ticketJob.ticket_number, workerCode, result.removal);

  return {
    message: "Worker removed from vehicle job successfully.",
    ticket_number: ticketJob.ticket_number,
    worker_code: workerCode,
    status: result.finishedStatus,
    booth_payouts: formatBoothPayoutResults(result.removal.outcomes),
  };
}

// Function ยกเลิก assignment ต่อถ้าถอดออกจาก Business Ticket/แผงแล้วไม่เหลืองานบนรถ (ยังมีงานคืน null)
async function cancelAssignmentIfNoRemainingWork(
  ticketJobId: number,
  workerId: number,
  workerCode: string,
  reason: AdminActionReason,
  actorId: number,
  transaction: DbConnection,
  source: string,
): Promise<{ assignment: TicketJobAssignmentDto; result: CancelledAssignmentResult } | null> {
  const hasRemainingWork = await ticketWorkerRepository.hasRemainingWorkOnTicketJob(
    ticketJobId,
    workerId,
    transaction,
  );

  if (hasRemainingWork) {
    return null;
  }

  const assignment =
    await assignmentRepository.findCurrentAssignmentByTicketJobIdAndWorker(
      ticketJobId,
      workerId,
      transaction,
    );

  if (!assignment || !ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status)) {
    return null;
  }

  await assertNotLastActiveWorker(assignment, transaction);

  const result = await cancelAssignmentInTransaction(
    assignment,
    workerCode,
    reason,
    actorId,
    transaction,
    { source },
  );

  return { assignment, result };
}

// Function ต่อเวลา scan ให้ worker ที่กดรับงานแล้ว
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

      // แพ้ race ให้ข้ามคนนี้ไป ไม่ให้ทั้งชุดล้ม
      if (extended) {
        results.push(extended);
      }
    }

    await adminActionLogRepository.create(
      {
        vehicle_job_id: ticketJobId,
        action_type: ADMIN_ACTION_TYPE.SCAN_DEADLINE_EXTENDED,
        reason_code: input.reason_code,
        reason_text: input.reason_text,
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

// Function ยกเลิก Business Ticket ตาม TicketNumber + TicketNo
async function cancelMarketJobByTicketContext(
  ticketNumber: string,
  ticketNo: string,
  reason: AdminActionReason,
  auth?: AccessTokenPayload,
): Promise<AdminMarketJobActionResponse> {
  const ticketJob = await requireTicketJobByRef(ticketNumber);
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

  return cancelMarketJobById(marketJob.id, reason, actorId);
}

// Function ยกเลิก Business Ticket (lock และเช็คว่ายังไม่จบก่อนเขียน)
async function cancelMarketJobById(
  marketJobId: number,
  reason: AdminActionReason,
  actorId: number,
): Promise<AdminMarketJobActionResponse> {
  const { marketJob, completedTicketJob, activeBooths } = await withTransaction(async (transaction) => {
    const target = await marketJobRepository.findMarketJobById(marketJobId, transaction);

    if (target) {
      await ticketJobRepository.lockTicketJob(target.vehicle_job_id, transaction);
    }

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

    // ห้ามยกเลิกถ้ามีแผงที่รอ Vendor ยืนยันหรือยืนยันแล้ว (แผง REJECT ยกเลิกได้)
    const blockingBoothCodes = await boothJobRepository.listCancelBlockingBoothCodes(
      { marketJobId },
      transaction,
    );

    if (blockingBoothCodes.length > 0) {
      throw new ApiError(
        409,
        "MARKET_JOB_ALREADY_SUBMITTED",
        "Business ticket cannot be cancelled while a booth is awaiting vendor confirmation or already confirmed.",
        { boothCodes: blockingBoothCodes },
      );
    }

    // ดึงแผงที่ยังไม่จบก่อนยกเลิก เพื่อแจ้ง LINE หลัง commit
    const activeBooths = await boothJobRepository.listActiveBoothsByMarketJobId(
      marketJobId,
      transaction,
    );

    const cancelled = await ticketJobLifecycleService.cancelMarketJob(marketJobId, transaction);

    // บันทึกผู้ยกเลิกและเหตุผล (ใช้ในรายงานรายได้ worker รายวัน)
    await adminActionLogRepository.create(
      {
        vehicle_job_id: cancelled.vehicle_job_id,
        market_job_id: cancelled.id,
        action_type: ADMIN_ACTION_TYPE.MARKET_JOB_CANCELLED,
        reason_code: reason.reasonCode,
        reason_text: reason.reasonText,
        actor_account_id: actorId,
      },
      transaction,
    );

    // อัปเดตสถานะ Business Ticket/รถต่อผ่าน lifecycle กลาง
    const completedTicketJob =
      await ticketJobLifecycleService.closeCompletedTicketJobIfReady(
        cancelled.vehicle_job_id,
        transaction,
      );

    await ticketJobLifecycleService.clearRejectStateIfNoRejectedBooth(
      cancelled.vehicle_job_id,
      transaction,
    );

    return { marketJob: cancelled, completedTicketJob, activeBooths };
  });

  // แจ้ง Driver Web หลัง commit
  publishDriverJobUpdate(
    marketJob.vehicle_job_id,
    completedTicketJob ? "DRIVER_JOB_TERMINAL" : "DRIVER_JOB_UPDATED",
  );

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

// Function ยกเลิกแผงตาม TicketNumber + TicketNo + BoothCode
async function cancelStallJobByTicketContext(
  ticketNumber: string,
  ticketNo: string,
  boothCode: string,
  reason: AdminActionReason,
  auth?: AccessTokenPayload,
): Promise<AdminStallJobActionResponse> {
  const ticketJob = await requireTicketJobByRef(ticketNumber);
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

  return cancelStallJobById(ticket.id, reason, actorId);
}

// Function ยกเลิกแผงพร้อมบันทึก log และอัปเดตสถานะต่อ (ต้องใช้ transaction ของผู้เรียกที่ lock แผงไว้แล้ว)
async function cancelStallJobRecord(
  ticket: BoothJobDto,
  reason: AdminActionReason,
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
      reason_code: reason.reasonCode,
      reason_text: reason.reasonText,
      actor_account_id: actorId,
      metadata: extraMetadata ?? null,
    },
    transaction,
  );

  // อัปเดตสถานะ Business Ticket/รถต่อผ่าน lifecycle กลาง (อาจปิดยอดเงินด้วย)
  const completedTicketJob =
    await ticketJobLifecycleService.closeCompletedTicketJobIfReady(
      cancelled.vehicle_job_id,
      transaction,
    );

  await ticketJobLifecycleService.clearRejectStateIfNoRejectedBooth(
    cancelled.vehicle_job_id,
    transaction,
  );

  return { ticket: cancelled, completedTicketJob };
}

// Function ยกเลิกแผง (lock และเช็คว่ายังไม่จบก่อนเขียน)
async function cancelStallJobById(
  ticketId: number,
  reason: AdminActionReason,
  actorId: number,
): Promise<AdminStallJobActionResponse> {
  const { ticket, completedTicketJob } = await withTransaction(async (transaction) => {
    const target = await boothJobRepository.findBoothJobForCompletion(ticketId, transaction);

    if (target) {
      await ticketJobRepository.lockTicketJob(target.vehicle_job_id, transaction);
    }

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

    // ห้ามยกเลิกแผงที่รอ Vendor ยืนยัน (COMPLETED ถูกกันด้วยเงื่อนไขแผงจบแล้วด้านบน ส่วน REJECT ยกเลิกได้)
    if (current.status === TICKET_STATUS.DELIVERED) {
      throw new ApiError(
        409,
        "STALL_JOB_ALREADY_SUBMITTED",
        "Stall job cannot be cancelled while it is awaiting vendor confirmation.",
      );
    }

    return cancelStallJobRecord(current, reason, actorId, transaction);
  });

  const { ticketJob, marketJob } = await publishStallJobCancelledSideEffects(
    ticket,
    completedTicketJob,
  );

  return formatStallJobActionResponse(
    "Stall job cancelled successfully.",
    ticket,
    ticketJob,
    marketJob,
  );
}

// Function ทำงานหลัง commit การยกเลิกแผง (แจ้ง Driver/Admin/Worker/LINE และคืนคิวถ้ารถปิดงาน)
async function publishStallJobCancelledSideEffects(
  ticket: BoothJobDto,
  completedTicketJob: CompletedTicketJobResult | null,
): Promise<{ ticketJob: TicketJobDto | null; marketJob: MarketJobDto | null }> {
  // แจ้ง Driver Web หลัง commit
  publishDriverJobUpdate(
    ticket.vehicle_job_id,
    completedTicketJob ? "DRIVER_JOB_TERMINAL" : "DRIVER_JOB_UPDATED",
  );

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

  return { ticketJob, marketJob };
}

// Function ถอด worker ออกจาก Business Ticket ใบเดียว พร้อมเลือกให้เงินรายแผง (ไม่เหลืองานบนรถยกเลิก assignment ด้วย)
async function cancelTicketWorker(
  ticketNumber: string,
  ticketNo: string,
  workerCode: string,
  request: WorkerRemovalRequest,
  auth?: AccessTokenPayload,
): Promise<AdminCancelTicketWorkerResponse> {
  const actorId = requireActorId(auth);
  const ticketJob = await requireTicketJobByRef(ticketNumber);
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

  const { removal, autoCancelledAssignment } = await withTransaction(async (transaction) => {
    // lock งานรถก่อนตามลำดับมาตรฐาน แล้วค่อยแผงของใบนี้
    await ticketJobRepository.lockTicketJob(ticketJob.id, transaction);
    await transaction.$queryRaw`SELECT id FROM booth_jobs WHERE market_job_id = ${marketJob.id} ORDER BY id FOR UPDATE`;

    const ticketWorker =
      await ticketWorkerRepository.findTicketWorkerByMarketJobAndWorkerAccountId(
        marketJob.id,
        worker.id,
        transaction,
      );
    const booths = await boothJobRepository.listBoothMembershipRecords(
      { marketJobId: marketJob.id },
      transaction,
    );
    const payoutBooths = listWorkerPayoutBooths(booths, worker.id);
    const isWorkingMember = ticketWorker?.status === TICKET_WORKER_STATUS.WORKING;

    if (!ticketWorker || (!isWorkingMember && payoutBooths.length === 0)) {
      throw new ApiError(
        404,
        "TICKET_WORKER_NOT_FOUND",
        "Worker is not a member of this business ticket.",
      );
    }

    await assertWorkerRemovalWindow(
      await requireTicketJobById(ticketJob.id, transaction),
      worker.id,
      transaction,
    );

    const removal = await removeWorkerFromBooths({
      booths,
      workerId: worker.id,
      workerCode,
      unpaidBoothIds: resolveUnpaidBoothIds(booths, payoutBooths, request.boothPayouts),
      reason: request,
      actorId,
      transaction,
    });

    if (isWorkingMember) {
      await ticketJobLifecycleService.cancelTicketWorkerForMarketJob(
        marketJob.id,
        worker.id,
        transaction,
      );
    }

    await adminActionLogRepository.create(
      {
        vehicle_job_id: ticketJob.id,
        market_job_id: marketJob.id,
        action_type: ADMIN_ACTION_TYPE.TICKET_WORKER_CANCELLED,
        reason_code: request.reasonCode,
        reason_text: request.reasonText,
        actor_account_id: actorId,
        metadata: {
          worker_id: worker.id,
          worker_code: workerCode,
          booth_payouts: formatBoothRemovalAudit(removal.outcomes),
        },
      },
      transaction,
    );

    // ไม่เหลืองานบนรถแล้วให้ยกเลิก assignment ด้วย (ข้ามถ้ารถปิดไปแล้ว)
    const autoCancelledAssignment = removal.completedTicketJob
      ? null
      : await cancelAssignmentIfNoRemainingWork(
        ticketJob.id,
        worker.id,
        workerCode,
        request,
        actorId,
        transaction,
        "auto_cancel_no_remaining_work_after_ticket_worker_cancelled",
      );

    return { removal, autoCancelledAssignment };
  });

  publishNotification({
    type: "TICKET_WORKER_CANCELLED",
    title: "Worker removed from business ticket",
    message: `Worker ${workerCode} was removed from ticket ${ticketNo} by admin.`,
    payload: {
      ticketNumber: ticketJob.ticket_number,
      ticketNo,
      worker_code: workerCode,
      status: TICKET_WORKER_STATUS.CANCELLED,
      booth_payouts: formatBoothPayoutResults(removal.outcomes),
    },
    audience: {
      roles: ["admin"],
    },
  });

  if (autoCancelledAssignment) {
    // แจ้ง ASSIGNMENT_CANCELLED อันเดียวแทน TICKET_WORKER_CANCELLED กัน push ซ้ำ
    await finalizeCancelledAssignment(
      autoCancelledAssignment.assignment,
      ticketJob,
      workerCode,
      autoCancelledAssignment.result,
      {
        reason: "admin_removed_from_last_ticket",
        workerPayload: {
          ticketNo,
          reason_code: request.reasonCode,
          reason_text: request.reasonText,
        },
      },
    );
  } else {
    // แจ้ง Worker ที่ถูกถอดออกเอง (socket + FCM) — Admin ได้ publishNotification ด้านบนแล้วจึงไม่ส่ง admin ซ้ำ
    publishRealtimeEvent({
      type: "TICKET_WORKER_CANCELLED",
      title: "Removed from business ticket",
      message: `Admin removed you from ticket ${ticketNo}.`,
      worker_payload: {
        ticketNumber: ticketJob.ticket_number,
        ticketNo,
        status: TICKET_WORKER_STATUS.CANCELLED,
        booth_payouts: formatBoothPayoutResults(removal.outcomes),
        reason_code: request.reasonCode,
        reason_text: request.reasonText,
      },
      worker_ids: [worker.id],
    });
  }

  await publishBoothRemovalSideEffects(ticketJob.ticket_number, workerCode, removal);

  return {
    message: autoCancelledAssignment
      ? "Worker removed from business ticket successfully. The worker had no remaining work on this vehicle job, so the assignment was cancelled too."
      : "Worker removed from business ticket successfully.",
    ticket_number: ticketJob.ticket_number,
    ticket_no: ticketNo,
    worker_code: workerCode,
    status: TICKET_WORKER_STATUS.CANCELLED,
    assignment_cancelled: Boolean(autoCancelledAssignment),
    booth_payouts: formatBoothPayoutResults(removal.outcomes),
  };
}

// Function ถอด worker ออกจากแผงเดียว (ไม่ได้เงินแผงนี้ ยังทำแผงอื่นต่อได้)
async function cancelTicketWorkerFromBooth(
  ticketNumber: string,
  ticketNo: string,
  boothCode: string,
  workerCode: string,
  request: WorkerRemovalRequest,
  auth?: AccessTokenPayload,
): Promise<AdminCancelTicketWorkerFromBoothResponse> {
  const actorId = requireActorId(auth);
  const ticketJob = await requireTicketJobByRef(ticketNumber);
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

  const { removal, autoCancelledAssignment } = await withTransaction(async (transaction) => {
    // lock งานรถก่อนตามลำดับมาตรฐาน แล้วค่อยแผงนี้
    await ticketJobRepository.lockTicketJob(ticketJob.id, transaction);
    await transaction.$queryRaw`SELECT id FROM booth_jobs WHERE id = ${ticket.id} FOR UPDATE`;

    const [booth] = await boothJobRepository.listBoothMembershipRecords(
      { id: ticket.id },
      transaction,
    );

    if (!booth) {
      throw new ApiError(
        409,
        "STALL_JOB_ALREADY_CLOSED",
        "Stall job is already cancelled.",
      );
    }

    const ticketWorkerId = findBoothTicketWorkerId(booth, worker.id);

    if (ticketWorkerId !== null && booth.excluded_ticket_worker_ids.includes(ticketWorkerId)) {
      throw new ApiError(
        409,
        "WORKER_ALREADY_EXCLUDED_FROM_BOOTH",
        "Worker is already excluded from this booth.",
      );
    }

    if (ticketWorkerId === null || !resolveBoothMemberTicketWorkerIds(booth).includes(ticketWorkerId)) {
      throw new ApiError(
        404,
        "TICKET_WORKER_NOT_FOUND",
        "Worker is not a member of this booth.",
      );
    }

    const currentTicketJob = await requireTicketJobById(ticketJob.id, transaction);

    await assertWorkerRemovalWindow(currentTicketJob, worker.id, transaction);

    const removal = await removeWorkerFromBooths({
      booths: [booth],
      workerId: worker.id,
      workerCode,
      unpaidBoothIds: new Set([booth.id]),
      reason: request,
      actorId,
      transaction,
    });

    await adminActionLogRepository.create(
      {
        vehicle_job_id: ticketJob.id,
        gate_ticket_id: booth.id,
        market_job_id: booth.market_job_id,
        action_type: ADMIN_ACTION_TYPE.TICKET_WORKER_CANCELLED_FROM_BOOTH,
        reason_code: request.reasonCode,
        reason_text: request.reasonText,
        actor_account_id: actorId,
        metadata: {
          worker_id: worker.id,
          worker_code: workerCode,
          booth_payouts: formatBoothRemovalAudit(removal.outcomes),
        },
      },
      transaction,
    );

    // ไม่เหลืองานบนรถแล้วให้ยกเลิก assignment ด้วย (ข้ามถ้ารถปิดแล้ว)
    const autoCancelledAssignment =
      removal.completedTicketJob || TERMINAL_JOB_STATUSES.includes(currentTicketJob.status)
        ? null
        : await cancelAssignmentIfNoRemainingWork(
          ticketJob.id,
          worker.id,
          workerCode,
          request,
          actorId,
          transaction,
          "auto_cancel_no_remaining_work_after_booth_exclusion",
        );

    return { removal, autoCancelledAssignment };
  });

  const boothCancelled = removal.outcomes.some((outcome) => outcome.cancelledBooth !== null);

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

  // แจ้ง worker ที่ถูกถอด (ถ้า assignment ถูกยกเลิกด้วยจะแจ้ง ASSIGNMENT_CANCELLED แทน)
  if (!autoCancelledAssignment) {
    publishRealtimeEvent({
      type: "TICKET_WORKER_CANCELLED_FROM_BOOTH",
      title: "Removed from booth",
      message: `Admin removed you from booth ${boothCode}.`,
      worker_payload: {
        ticketNumber: ticketJob.ticket_number,
        ticketNo,
        boothCode,
        status: TICKET_WORKER_STATUS.CANCELLED,
        booth_cancelled: boothCancelled,
        reason_code: request.reasonCode,
        reason_text: request.reasonText,
      },
      worker_ids: [worker.id],
    });
  }

  await publishBoothRemovalSideEffects(ticketJob.ticket_number, workerCode, removal);

  if (autoCancelledAssignment) {
    await finalizeCancelledAssignment(
      autoCancelledAssignment.assignment,
      ticketJob,
      workerCode,
      autoCancelledAssignment.result,
      {
        reason: "admin_removed_from_last_booth",
        workerPayload: {
          ticketNo,
          boothCode,
          booth_cancelled: boothCancelled,
          reason_code: request.reasonCode,
          reason_text: request.reasonText,
        },
      },
    );
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
    assignment_cancelled: Boolean(autoCancelledAssignment),
    booth_payouts: formatBoothPayoutResults(removal.outcomes),
  };
}

// Function ให้ Admin ส่งยอดแผงแทน worker (เฉพาะแผงที่ worker เคยส่งแล้ว) พร้อมบันทึกเหตุผล
export async function overrideTicketProductCounts(
  ticketNumberParam: unknown,
  ticketNoParam: unknown,
  boothCodeParam: unknown,
  body: unknown,
  auth?: AccessTokenPayload,
): Promise<AdminOverrideCountResponse> {
  const ticketJob = await requireTicketJobByRef(ticketNumberParam);
  const ticketNo = parseRequiredReference(
    ticketNoParam,
    "INVALID_TICKET_NO",
    "TicketNo is invalid.",
  );
  const boothCode = parseRequiredReference(
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

  // แจ้ง Driver Web ว่าแผงถูกส่งยอดแล้ว — เรียกหลัง transaction ข้างบน commit สำเร็จแล้วเท่านั้น
  publishDriverJobUpdate(result.ticket.vehicle_job_id, "DRIVER_JOB_UPDATED");

  // ยอดบันทึกแล้ว การแจ้ง Vendor ต่อจากนี้เป็น best-effort
  try {
    await ticketCompletionService.notifyTicketCompletionSubmitted(result);
  } catch (error) {
    logger.error("Failed to notify vendor after admin submitted ticket completion.", {
      ticketId: result.ticket.id,
      submissionId: result.submission.id,
      error,
    });
  }

  // ทุกแผงส่งครบและมีคนหมดกะแล้ว ให้ปล่อยทีมกลับคิวอัตโนมัติ (best-effort)
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
    reason_text: input.reason_text,
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

// Function เปิด/ปิด dispatch ของงานรถ (ปิด = คืนทีมเข้าคิวหน้าสุด) ทำได้เฉพาะก่อนทีม scan ครบ
export async function changeTicketJobToWait(
  ticketNumberParam: unknown,
  body: unknown,
  auth?: AccessTokenPayload,
): Promise<AdminVehicleWaitResponse> {
  const ticketJob = await requireTicketJobByRef(ticketNumberParam);
  const input = parseWithSchema(adminVehicleWaitBodySchema, body);
  const actorId = requireActorId(auth);

  const { updated, cancelledAssignments } = await withTransaction(async (transaction) => {
    // lock รถแล้วเช็คใหม่ว่าทีมยัง scan ไม่ครบ กัน race กับคนสุดท้ายที่กำลัง scan
    await transaction.$queryRaw`SELECT id FROM ticket_jobs WHERE id = ${ticketJob.id} FOR UPDATE`;

    // ต้องอ่านสถานะใหม่หลังได้ lock — ticketJob ด้านนอกอ่านมาก่อน lock อาจถูกยกเลิก/ปิดไปแล้วระหว่างนั้น
    const currentTicketJob = await ticketJobRepository.findTicketJobById(
      ticketJob.id,
      transaction,
    );

    if (!currentTicketJob || TERMINAL_JOB_STATUSES.includes(currentTicketJob.status)) {
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

  // แจ้ง Driver Web ว่า dispatch/สถานะรถเปลี่ยน — เรียกหลัง transaction ข้างบน commit สำเร็จแล้วเท่านั้น
  publishDriverJobUpdate(ticketJob.id, "DRIVER_JOB_UPDATED");

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

    // ส่ง ASSIGNMENT_CANCELLED (มี push) คู่กับ WORKER_STATUS_CHANGED ให้แอปที่ปิดอยู่รู้ด้วย
    const ticketNos = await marketJobRepository.listActiveTicketNosByTicketJobId(
      ticketJob.id,
    );
    const notifyAssignmentCancelledByWait = (
      workerId: number,
      workerStatus: string,
      reason: string,
    ) => {
      sendWorkerSocketEvent(workerId, "WORKER_STATUS_CHANGED", {
        status: workerStatus,
        reason,
      });
      sendWorkerSocketEvent(workerId, "ASSIGNMENT_CANCELLED", {
        ticketNumber: ticketJob.ticket_number,
        ticketNos,
        reason,
        worker_status: workerStatus,
        reason_code: input.reason_code,
        reason_text: input.reason_text,
      });
    };

    for (const workerId of requeuedWorkerIds) {
      notifyAssignmentCancelledByWait(
        workerId,
        WORKER_WORK_STATUS.READY,
        "vehicle_job_wait_requeue",
      );
    }
    for (const workerId of openAppIds) {
      notifyAssignmentCancelledByWait(
        workerId,
        WORKER_WORK_STATUS.OPEN_APP,
        "vehicle_job_wait_shift_ended",
      );
    }
    [requeuedWorkerCodes, openAppWorkerCodes] = await Promise.all([
      profileRepository.findWorkerCodesByAccountIds(requeuedWorkerIds),
      profileRepository.findWorkerCodesByAccountIds(openAppIds),
    ]);
    // dispatch ทันทีให้ worker ที่กลับเข้าคิวไปรับงานคันอื่นได้ (best-effort)
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
      await dispatchReadyWorkers();
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
    reason_text: input.reason_text,
  };
}

// Function ปล่อยทีมกลับคิวก่อนเวลาเมื่อทุกแผงส่งยอดแล้วและไม่มีแผงค้างตีกลับ
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
    // lock รถแล้วอ่านใหม่ กัน RELEASED เขียนทับ COMPLETED จาก Vendor ยืนยันพร้อมกัน
    await transaction.$queryRaw`SELECT id FROM ticket_jobs WHERE id = ${ticketJob.id} FOR UPDATE`;

    const currentTicketJob = await ticketJobRepository.findTicketJobById(
      ticketJob.id,
      transaction,
    );

    if (!currentTicketJob || TERMINAL_JOB_STATUSES.includes(currentTicketJob.status)) {
      throw new ApiError(
        409,
        "VEHICLE_JOB_CLOSED",
        "Vehicle job is already closed; workers already returned to queue.",
      );
    }

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

    // แผงต้องส่งยอดแล้ว (DELIVERED/จบแล้ว) ส่วน REJECT ยังต้องส่งใหม่
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

    // เรียงตาม accepted_at ก่อนคืนเข้าคิว ให้ลำดับในทีมตรงกับตอนรับงาน
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

    // RELEASED กันไม่ให้ dispatch ดึง worker กลับมารถคันนี้อีก
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
        reason_text: input.reason_text,
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

  // แจ้ง Driver Web ว่ารถเปลี่ยนเป็น RELEASED — เรียกหลัง transaction ข้างบน commit สำเร็จแล้วเท่านั้น
  publishDriverJobUpdate(ticketJob.id, "DRIVER_JOB_UPDATED");

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
    reason_text: input.reason_text,
  };
}

// Function ตัดสิน payment_status ของแถวรายได้ worker (cancel > success/partial > reject > null)
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

  // reject ที่เจอหลัง release แปลว่าถูกตีกลับหลังปล่อยทีมแล้ว
  if (hasUnresolvedReject) {
    return isReleased
      ? DAILY_WORKER_INCOME_PAYMENT_STATUS.ADMIN_REJECT
      : DAILY_WORKER_INCOME_PAYMENT_STATUS.WORKER_REJECT;
  }

  return null;
}

// Config ข้อความความเสี่ยงในรายงานรายได้ worker รายวัน
const DAILY_WORKER_INCOME_RISK_TEXT = {
  WORKER_CANCELLED_BY_ADMIN: "Admin เตะคนงานกลางคัน",
  PARTIAL_PAY_CONFIRMED_STALLS_ONLY: "จ่ายเฉพาะแผงที่ยืนยันแล้ว",
  REMOVED_FROM_SUBMITTED_BOOTH: "Admin ถอดออกจากแผงที่ส่งยอดแล้ว (ไม่ให้เงินแผงนั้น)",
  REJECTED_REQUIRES_ADMIN_CORRECTION: "แผงปฏิเสธหลังปล่อยคิว/ต้องให้ Admin แก้",
  REJECTION_CORRECTED_BY_ADMIN: "เคยปฏิเสธและ Admin แก้ยอดแล้ว",
  REJECTED_REQUIRES_WORKER_CORRECTION: "แผงปฏิเสธ รอชุดแรงงานแก้ยอด",
  COUNT_SUBMITTED_BY_ADMIN: "Admin ส่งยอดแทน",
  AUTO_CONFIRMED_BY_SYSTEM: "ระบบตัดยืนยัน",
  MARKET_CANCELLED: "ตลาดนี้ถูกยกเลิก",
  VEHICLE_JOB_CANCELLED: "งานถูกยกเลิก",
} as const;

// Function เพิ่มข้อความความเสี่ยงโดยไม่ซ้ำ
function addDailyRiskText(messages: string[], message: string): void {
  if (!messages.includes(message)) {
    messages.push(message);
  }
}

// Function ดึง action_type จาก admin log
function getDailyAdminActionType(log: unknown): string | null {
  if (!log) {
    return null;
  }

  const record = log as { actionType?: string | null; action_type?: string | null };

  return record.actionType ?? record.action_type ?? null;
}

// Function สร้างข้อความความเสี่ยงของแถวรายได้ worker รายวัน
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

  // ถูกถอดออกจากแผงที่ส่งยอดแล้วแบบไม่ให้เงิน (ตรวจสอบย้อนหลังได้จาก audit)
  if (
    tickets.some(
      (ticket) =>
        ticket.completionSubmissions.length > 0 &&
        (ticket.workerExclusions ?? []).some((exclusion) => exclusion.ticketWorkerId === record.id),
    )
  ) {
    addDailyRiskText(
      messages,
      DAILY_WORKER_INCOME_RISK_TEXT.REMOVED_FROM_SUBMITTED_BOOTH,
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

// Function จัดรูปแบบแถวรายได้ worker รายวัน (ไม่เข้า payment_status ไหนคืน null)
function formatDailyWorkerIncomeItem(
  record: DailyWorkerIncomeRecord,
): DailyWorkerIncomeItemResponse | null {
  const { marketJob } = record;
  const { ticketJob } = marketJob;
  const matchingAssignments = ticketJob.assignments
    .filter((assignment) => assignment.workerId === record.workerId)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const assignment = matchingAssignments[0] ?? null;
  // เวลาส่งยอดล่าสุดของ ticket_no นี้ (ทุกแถวของ ticket_no เดียวกันใช้ค่าเดียวกัน)
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

  // หา log ยกเลิกของ ticket_no ถ้าไม่มีใช้ log ยกเลิกทั้งรถ
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
    shift: record.worker.shiftName ?? null,
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
          cancelled_by_type: cancelLog?.actor?.role ?? (cancelLog?.actorGateClient ? "gate" : null),
          cancelled_by_name: cancelLog?.actor?.fullName ?? cancelLog?.actorGateClient?.name ?? null,
        }
        : null,
    riskText,
  };
}

// Function ดึงรายงานรายได้ worker รายวันสำหรับ Admin
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
  const dateRange = buildBangkokDateSpanRange(filters.date_from, filters.date_to);
  const page = filters.page ?? 1;
  const limit = filters.limit ?? DEFAULT_PAGE_LIMIT;
  const result = await adminJobsRepository.listDailyWorkerIncome({
    workerCode: filters.worker_code,
    status: filters.status,
    shift: filters.shift,
    search: filters.search,
    ...dateRange,
  });

  // payment_status ต้อง derive ก่อน จึงกรองและแบ่งหน้าที่ service
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

// Function ดึงยอดแผงที่ปัดแล้วของสินค้า (บันทึกไว้ตอน Vendor ยืนยัน)
function requireDailyStallFeeRounded(record: DailyStallFeeRecord): Prisma.Decimal {
  if (record.product.stallFeeRounded === null) {
    throw new ApiError(
      500,
      "TICKET_FINANCIAL_STATE_INVALID",
      `Financialized ticket product ${record.product.id} does not have stall charge.`,
    );
  }

  return record.product.stallFeeRounded;
}

// Function จัดรูปแบบแถวรายงานค่าลงสินค้ารายวัน (ใช้ยอดที่ปิดแล้ว ไม่คำนวณใหม่)
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
    stall_fee_rounded: requireDailyStallFeeRounded(record).toFixed(2),
  };
}

// Function ดึงรายงานค่าลงสินค้าแผงค้ารายวันสำหรับ Admin (กรองและแบ่งหน้าที่ DB)
export async function listDailyStallFees(query: unknown): Promise<DailyStallFeeListResponse> {
  const filters = parseWithSchema(adminDailyStallFeeQuerySchema, query);
  const dateRange = buildBangkokDateSpanRange(filters.date_from, filters.date_to);
  // date_from/date_to บังคับใน schema จึงมี startAt/endAt เสมอ
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

// Function จัดรูปแบบแถวรายงานค่าลงสินค้ารายเดือน (id ประกอบจาก group key)
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

// Function ดึงรายงานค่าลงสินค้าแผงค้ารายเดือนสำหรับ Admin (group ตามตลาด แผง และสีเสื้อ)
export async function listMonthlyStallFees(query: unknown): Promise<MonthlyStallFeeListResponse> {
  const filters = parseWithSchema(adminMonthlyStallFeeQuerySchema, query);
  const dateRange = buildBangkokDateSpanRange(filters.date_from, filters.date_to);
  // date_from/date_to บังคับใน schema จึงมี startAt/endAt เสมอ
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
