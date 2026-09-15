// Import Libraries
import { withTransaction } from "../db/prisma";
// Import Repositories
import * as adminActionLogRepository from "../repositories/shared/admin-action-log.repository";
import * as workScheduleRepository from "../repositories/shared/work-schedule.repository";
import * as marketJobRepository from "../repositories/shared/market-job.repository";
import * as profileRepository from "../repositories/shared/profile.repository";
import * as assignmentRepository from "../repositories/shared/ticket-job-assignment.repository";
import * as boothJobRepository from "../repositories/shared/booth-job.repository";
import * as ticketJobRepository from "../repositories/shared/ticket-job.repository";
import * as workerCheckinLogRepository from "../repositories/shared/worker-checkin-log.repository";
// Import Services
import { getRuntimeSettings } from "../services/shared/runtime-settings.service";
import { closeWorkerBreakLog } from "../services/shared/worker-attendance.service";
import * as ticketJobLifecycleService from "../services/shared/ticket-job-lifecycle.service";
import { publishAdminWorkerStatusChanged, publishNotification } from "../services/notifications.service";
import { publishRealtimeEvent } from "../services/shared/realtime-notification.service";
import { applyVendorTicketCompletionResult } from "../services/shared/ticket-completion.service";
import { sendMobileAppForceUpdateNotification, sendMobileAppReleaseNotification } from "../services/shared/mobile-app-version.service";
// Import Types
import type { DbConnection } from "../types/shared/common.type";
import type { AssignmentAcceptTimeoutResult, AssignmentTimeoutJobData, AssignmentTimeoutQueueAction, CompletedWorkerQueueResult, TicketJobAssignmentDto, TicketJobDto, WorkerQueueEntryDto } from "../types/worker.type";
import type { WorkScheduleDto } from "../types/admin-workers.type";
import { ADMIN_ACTION_TYPE } from "../types/shared/admin-action-log.type";
import { WORKER_ASSIGNMENT_EVENT_TYPE } from "../types/shared/worker-assignment-event.type";
import { WORKER_WORK_STATUS } from "../types/shared/worker-status.type";
// Import Utils
import { isWorkerSocketConnected, sendWorkerSocketEvent } from "../websockets/worker.socket";
import { enqueueWorker, enqueueWorkersAtFront, getWorkerQueueStatus, markWorkerAssigned, markWorkerOpenApp, popReadyWorkers, removeScanWarning, scheduleAssignmentTimeout, scheduleScanTimeout, scheduleScanWarning, scheduleWorkerShiftEnd, startAssignmentTimeoutWorker, startWorkerBreakReturnWorker } from "./worker-queue";
import { buildWorkScheduleShiftInstanceKey, getWorkScheduleShiftEndDelayMs, isTimeInWorkSchedule } from "../utils/shift";
import { buildTicketCompletionResultExtraFields, buildWorkerTicketPayload } from "../utils/ticket-payload";
import { logger } from "../utils/logger";
import { buildDeadline, getDelayUntil } from "../utils/time";
import { buildWorkerAssignedPayload, buildWorkerQueueSocketPayload } from "../utils/worker-payload";
import { ASSIGNMENT_STATUS, SUBMITTED_TICKET_STATUSES, TERMINAL_JOB_STATUSES, TICKET_STATUS, VEHICLE_JOB_STATUS } from "../constants/status";

/* -------------------------------------- Functions -------------------------------------- */

// Function จ่าย worker สถานะ ready จากคิว Redis FIFO ไปยังงานรถที่ยังขาดแรงงาน
export async function dispatchReadyWorkers(
  connection?: Parameters<typeof ticketJobRepository.listDispatchableTicketJobs>[0],
  options: {
    vehicle_job_ids?: number[];
  } = {}
): Promise<void> {
  const settings = await getRuntimeSettings();
  const acceptDeadlineMs = settings.worker_accept_deadline_seconds * 1000;
  const allowedTicketJobIds = options.vehicle_job_ids
    ? new Set(options.vehicle_job_ids)
    : null;
  const dispatchableJobs = (await ticketJobRepository.listDispatchableTicketJobs(connection))
    .filter((ticketJob) => !allowedTicketJobIds || allowedTicketJobIds.has(ticketJob.id));

  for (const ticketJob of dispatchableJobs) {
    await dispatchReadyWorkersForTicketJob(ticketJob, acceptDeadlineMs, connection);
  }
}

// Function จ่าย Worker ให้ TicketJob คันเดียวภายใต้ lock
async function dispatchReadyWorkersForTicketJob(
  ticketJob: Awaited<ReturnType<typeof ticketJobRepository.listDispatchableTicketJobs>>[number],
  acceptDeadlineMs: number,
  connection?: DbConnection
): Promise<void> {
  if (!connection) {
    return withTransaction((transaction) =>
      dispatchReadyWorkersForTicketJob(ticketJob, acceptDeadlineMs, transaction)
    );
  }

  await connection.$queryRaw`SELECT id FROM ticket_jobs WHERE id = ${ticketJob.id} FOR UPDATE`;

  const activeAssignments = await assignmentRepository.countActiveAssignments(
    ticketJob.id,
    connection
  );
  let workersNeeded = ticketJob.workers_required - activeAssignments;

  if (workersNeeded <= 0) {
    return;
  }

  while (workersNeeded > 0) {
    const readyWorkers = await popReadyWorkers(workersNeeded);

    // ถ้าไม่มี Worker ที่พร้อมจะ dispatch ให้ TicketJob คันนี้แล้ว ให้ break ออกจาก loop
    if (readyWorkers.length === 0) {
      break;
    }

    // ดึง workerCode ของ Worker ที่ dispatch ได้จาก DB เพื่อใช้ใน notification และ log
    let workerCodeMap: Map<number, string | null>;

    try {
      workerCodeMap = await profileRepository.findWorkerCodeMapByAccountIds(
        readyWorkers.map((worker) => worker.worker_id),
        connection
      );
    } catch (error) {
      logger.error("Failed to load worker code map while dispatching workers.", {
        ticketJobId: ticketJob.id,
        workerIds: readyWorkers.map((worker) => worker.worker_id),
        error,
      });
      workerCodeMap = new Map();
    }

    for (const worker of readyWorkers) {
      const workerCode = workerCodeMap.get(worker.worker_id) ?? null;
      let assignment: TicketJobAssignmentDto;

      try {
        const workerSchedule = await workScheduleRepository.findCurrentByAccountId(
          worker.worker_id,
          connection
        );

        if (!workerSchedule || !isTimeInWorkSchedule(workerSchedule)) {
          if (workerSchedule) {
            await ejectWorkerForShiftEnd(worker.worker_id, workerSchedule);
          } else {
            await markWorkerOpenApp(worker.worker_id);
          }

          continue;
        }

        assignment = await assignmentRepository.createAssignment(
          ticketJob.id,
          worker.worker_id,
          buildDeadline(acceptDeadlineMs),
          connection
        );
        await markWorkerAssigned(worker.worker_id);
        await scheduleAssignmentTimeout(
          assignment.id,
          worker.worker_id,
          acceptDeadlineMs
        );
      } catch (error) {
        // ถ้าเกิด error ระหว่างสร้าง Assignment ให้ TicketJob ให้ log error
        logger.error("Failed to create assignment while dispatching worker.", {
          ticketJobId: ticketJob.id,
          workerId: worker.worker_id,
          error,
        });
        await enqueueWorker(worker.worker_id);
        continue;
      }

      // ส่ง notification ไปยัง Worker และ Admin หลังจากสร้าง Assignment สำเร็จแล้ว
      try {
        const tickets = await marketJobRepository.listActiveTicketSummariesByTicketJobId(
          ticketJob.id,
          connection
        );

        sendWorkerSocketEvent(
          worker.worker_id,
          "WORKER_ASSIGNED",
          buildWorkerAssignedPayload(assignment, ticketJob, tickets)
        );
        publishNotification({
          type: "WORKER_ASSIGNED",
          title: "Worker assigned",
          message: `Worker ${workerCode ?? worker.worker_id} was assigned to vehicle job ${ticketJob.ticket_number}.`,
          payload: {
            ticketNumber: ticketJob.ticket_number,
            worker_code: workerCode,
            status: assignment.status,
            accept_deadline_at: assignment.accept_deadline_at,
          },
          audience: {
            roles: ["admin"],
          },
        });
      } catch (error) {
        logger.error("Failed to notify worker/admin after successful dispatch assignment.", {
          ticketJobId: ticketJob.id,
          workerId: worker.worker_id,
          assignmentId: assignment.id,
          error,
        });
      }

      workersNeeded -= 1;
    }
  }
}

/* -------------------------------------- Timeout Handlers -------------------------------------- */

// Function จัดการ assignment accept timeout แบบกัน race
export async function handleAssignmentAcceptTimeout(input: {
  assignment: TicketJobAssignmentDto;
  workerId: number;
  connection?: DbConnection;
}): Promise<AssignmentAcceptTimeoutResult | null> {
  const timedOutAssignment = await assignmentRepository.timeoutAssignment(
    input.assignment.id,
    WORKER_ASSIGNMENT_EVENT_TYPE.ACCEPT_TIMEOUT,
    input.connection
  );

  if (!timedOutAssignment) {
    return null;
  }

  const settings = await getRuntimeSettings();
  const currentSchedule = await workScheduleRepository.findCurrentByAccountId(
    input.workerId,
    input.connection
  );
  const hasActiveSchedule =
    currentSchedule !== null && isTimeInWorkSchedule(currentSchedule);
  let timeoutCount = 1;
  let queueAction: AssignmentTimeoutQueueAction;
  let reason = "assignment_timeout_requeue";
  let closedShift = false;

  if (hasActiveSchedule) {
    const shiftInstanceKey = buildWorkScheduleShiftInstanceKey(currentSchedule);
    const workerCode = await profileRepository.findWorkerCodeByAccountId(
      input.workerId,
      input.connection
    );
    const attendance = await workerCheckinLogRepository.incrementAcceptTimeoutStreak(
      {
        worker_id: input.workerId,
        worker_code: workerCode ?? String(input.workerId),
        schedule: currentSchedule,
        shift_instance_key: shiftInstanceKey,
      },
      input.connection
    );
    timeoutCount = attendance.acceptTimeoutStreak;

    if (timeoutCount >= settings.worker_accept_timeout_limit) {
      await workerCheckinLogRepository.closeWorkerShift(
        {
          worker_id: input.workerId,
          worker_code: workerCode ?? String(input.workerId),
          schedule: currentSchedule,
          shift_instance_key: shiftInstanceKey,
          reason: "assignment_timeout_limit_reached",
        },
        input.connection
      );
      queueAction = "open_app";
      reason = "assignment_timeout_limit_reached";
      closedShift = true;
    } else {
      queueAction = "requeue";
    }
  } else {
    queueAction = "open_app";
    reason = "assignment_timeout_shift_unavailable";
  }

  // หมายเหตุ: ไม่เรียก Redis (enqueueWorker/markWorkerOpenApp) ที่นี่ตรงๆ เพราะ function นี้ถูกเรียกจากใน
  // ทรานแซกชัน DB เสมอ — ให้ผู้เรียกเป็นคนเรียก applyAssignmentTimeoutQueueAction ทีหลัง commit แล้วแทน
  // กันทรานแซกชันถือ connection ค้างนานจน Prisma interactive transaction หมดเวลา (default 5000ms)
  return {
    queue_action: queueAction,
    reason,
    timeout_count: timeoutCount,
    timeout_limit: settings.worker_accept_timeout_limit,
    closed_shift: closedShift,
  };
}

// Function แปลง queue action ที่ handleAssignmentAcceptTimeout ตัดสินใจไว้ ให้เป็นการเขียนคิวจริงใน Redis
// ต้องเรียกหลัง transaction ของ DB commit แล้วเสมอ
export async function applyAssignmentTimeoutQueueAction(
  action: AssignmentTimeoutQueueAction,
  workerId: number
): Promise<WorkerQueueEntryDto> {
  return action === "requeue" ? enqueueWorker(workerId) : markWorkerOpenApp(workerId);
}

// Function จัดการ assignment scan timeout แบบกัน race
async function handleAssignmentScanTimeout(input: {
  assignment: TicketJobAssignmentDto;
  workerId: number;
  connection: DbConnection;
}): Promise<boolean> {
  if (input.assignment.status !== ASSIGNMENT_STATUS.ACCEPTED) {
    return false;
  }

  const remainingDelayMs = getDelayUntil(input.assignment.scan_deadline_at);

  if (remainingDelayMs > 0) {
    await Promise.all([
      scheduleScanTimeout(
        input.assignment.id,
        input.assignment.worker_id,
        remainingDelayMs
      ),
      scheduleScanWarning(
        input.assignment.id,
        input.assignment.worker_id,
        input.assignment.scan_deadline_at
      ),
    ]);
    return false;
  }

  const timedOutAssignment = await assignmentRepository.timeoutAssignment(
    input.assignment.id,
    WORKER_ASSIGNMENT_EVENT_TYPE.SCAN_TIMEOUT,
    input.connection
  );

  // ถ้า assignment ถูก accept หรือ complete ไปแล้วก่อนหน้านี้ ให้ return false เพราะไม่ต้องทำอะไรต่อ
  if (!timedOutAssignment) {
    return false;
  }

  const teamScan = await assignmentRepository.getTicketJobTeamScanReadiness(
    input.assignment.vehicle_job_id,
    input.connection,
  );

  if (teamScan.is_ready) {
    await ticketJobLifecycleService.markTicketJobInProgress(
      input.assignment.vehicle_job_id,
      input.connection,
    );
  }

  // หมายเหตุ: ไม่ทำ Redis call/notification ที่นี่ตรงๆ (ย้ายไปทำหลัง transaction commit ใน
  // startAssignmentTimeoutProcessing แทน) เพื่อลดเวลาที่ทรานแซกชันถือ connection ค้างไว้ — เป็นจุดที่
  // เคยทำให้ query ถัดไปชน "Transaction API error: query cannot be executed on an expired transaction"
  // แล้วทำให้ทั้งทรานแซกชัน rollback จนสถานะ assignment ค้างที่ ACCEPTED ถาวร
  return true;
}

// Function แจ้ง Admin และ Worker เมื่อ assignment ที่ accept แล้วใกล้หมดเวลา scan QR
async function handleAssignmentScanWarning(input: {
  assignment: TicketJobAssignmentDto;
  workerId: number;
  connection: DbConnection;
}): Promise<void> {
  if (input.assignment.status !== ASSIGNMENT_STATUS.ACCEPTED) {
    return;
  }

  const settings = await getRuntimeSettings();
  const remainingDelayMs = getDelayUntil(input.assignment.scan_deadline_at);
  const warningBeforeMs = settings.worker_scan_warning_before_minutes * 60 * 1000;

  if (remainingDelayMs <= 0) {
    return;
  }

  if (remainingDelayMs > warningBeforeMs) {
    await scheduleScanWarning(
      input.assignment.id,
      input.assignment.worker_id,
      input.assignment.scan_deadline_at
    );
    return;
  }

  const [ticketJob, workerCode] = await Promise.all([
    ticketJobRepository.findTicketJobById(
      input.assignment.vehicle_job_id,
      input.connection
    ),
    profileRepository.findWorkerCodeByAccountId(input.workerId),
  ]);
  const remainingSeconds = Math.ceil(remainingDelayMs / 1000);
  const remainingMinutes = Math.ceil(remainingDelayMs / 60000);

  publishNotification({
    type: "ASSIGNMENT_SCAN_DEADLINE_WARNING",
    title: "Worker has not checked in",
    message: `Worker ${workerCode ?? input.workerId} has not checked in and the scan deadline is near.`,
    payload: {
      ticketNumber: ticketJob?.ticket_number ?? null,
      worker_code: workerCode,
      assignment_status: input.assignment.status,
      worker_status: WORKER_WORK_STATUS.ASSIGNED,
      scan_deadline_at: input.assignment.scan_deadline_at,
      remaining_seconds: remainingSeconds,
      warning_before_minutes: settings.worker_scan_warning_before_minutes,
    },
    audience: {
      roles: ["admin"],
    },
  });

  sendWorkerSocketEvent(input.workerId, "ASSIGNMENT_SCAN_DEADLINE_WARNING", {
    ticketNumber: ticketJob?.ticket_number ?? null,
    scan_deadline_at: input.assignment.scan_deadline_at,
    remaining_seconds: remainingSeconds,
    remaining_minutes: remainingMinutes,
    warning_before_minutes: settings.worker_scan_warning_before_minutes,
  });
}

/* -------------------------------------- Completion Helpers -------------------------------------- */

// Function ส่ง worker ที่จบงานกลับเข้าคิวเมื่อ Shift ยังทำงานต่อได้
export async function returnCompletedWorkersToQueue(
  input: CompletedWorkerQueueResult | null
): Promise<Array<string | null>> {
  if (!input || input.completed_worker_ids.length === 0) {
    return [];
  }

  const requeuedWorkerCodes: Array<string | null> = [];
  const workerCodeMap = await profileRepository.findWorkerCodeMapByAccountIds(
    input.completed_worker_ids
  );

  for (const workerId of input.completed_worker_ids) {
    const workerCode = workerCodeMap.get(workerId) ?? null;
    const [currentSchedule, currentAssignment] = await Promise.all([
      workScheduleRepository.findCurrentByAccountId(workerId),
      assignmentRepository.findCurrentAssignmentByWorker(workerId),
    ]);

    if (currentAssignment) {
      continue;
    }

    const canReturnToQueue =
      currentSchedule &&
      isTimeInWorkSchedule(currentSchedule);

    if (canReturnToQueue) {
      const queue = await enqueueWorker(workerId);
      requeuedWorkerCodes.push(workerCode);
      sendWorkerSocketEvent(workerId, "WORKER_STATUS_CHANGED", {
        queue: buildWorkerQueueSocketPayload(queue, workerCode),
      });
      publishAdminWorkerStatusChanged({
        title: "Worker returned to queue",
        message: `Worker ${workerCode ?? workerId} returned to queue after vehicle job completion.`,
        workerCode,
        queue,
        reason: "vehicle_job_completed_requeue",
        extraPayload: {
          ticketNumber: input.vehicle_job.ticket_number,
        },
      });
      continue;
    }

    const queue = await markWorkerOpenApp(workerId);
    if (isWorkerSocketConnected(workerId)) {
      sendWorkerSocketEvent(workerId, "WORKER_STATUS_CHANGED", {
        queue: buildWorkerQueueSocketPayload(queue, workerCode),
      });
    }
    publishAdminWorkerStatusChanged({
      title: "Worker moved to open_app",
      message: `Worker ${workerCode ?? workerId} moved to open_app after vehicle job completion.`,
      workerCode,
      queue,
      reason: "vehicle_job_completed_not_available",
      extraPayload: {
        ticketNumber: input.vehicle_job.ticket_number,
      },
    });
  }

  if (requeuedWorkerCodes.length > 0) {
    await dispatchReadyWorkers();
  }

  return requeuedWorkerCodes;
}

// Function พยายาม requeue worker ที่จบงานกลับเข้าคิวถ้ายังอยู่ใน Shift และ mark open_app ถ้าไม่อยู่ใน Shift
export async function requeueWorkersAtFrontRespectingShift(
  workerIds: number[]
): Promise<{ requeuedWorkerIds: number[]; openAppWorkerIds: number[] }> {
  const uniqueWorkerIds = [...new Set(workerIds)];

  if (uniqueWorkerIds.length === 0) {
    return { requeuedWorkerIds: [], openAppWorkerIds: [] };
  }

  const schedules = await Promise.all(
    uniqueWorkerIds.map((workerId) => workScheduleRepository.findCurrentByAccountId(workerId)),
  );

  const requeuedWorkerIds: number[] = [];
  const openAppWorkerIds: number[] = [];

  uniqueWorkerIds.forEach((workerId, index) => {
    const schedule = schedules[index];

    if (schedule && isTimeInWorkSchedule(schedule)) {
      requeuedWorkerIds.push(workerId);
    } else {
      openAppWorkerIds.push(workerId);
    }
  });

  if (requeuedWorkerIds.length > 0) {
    await enqueueWorkersAtFront(requeuedWorkerIds);
  }

  await Promise.all(openAppWorkerIds.map((workerId) => markWorkerOpenApp(workerId)));

  return { requeuedWorkerIds, openAppWorkerIds };
}

// Function เรียง assignment ของ TicketJob ตามเวลาที่ accept หรือเวลาที่สร้าง (ถ้า accept_at เป็น null) และ fallback ไปตาม id ถ้าเวลาเท่ากัน
function sortAssignmentsByAcceptedAt(
  assignments: TicketJobAssignmentDto[]
): TicketJobAssignmentDto[] {
  const priorityAt = (assignment: TicketJobAssignmentDto): number => {
    const value = assignment.accepted_at ?? assignment.created_at;
    const timestamp = value ? new Date(value).getTime() : Number.POSITIVE_INFINITY;

    return Number.isNaN(timestamp) ? Number.POSITIVE_INFINITY : timestamp;
  };

  return [...assignments].sort((left, right) => {
    const leftPriorityAt = priorityAt(left);
    const rightPriorityAt = priorityAt(right);

    if (leftPriorityAt !== rightPriorityAt) {
      return leftPriorityAt - rightPriorityAt;
    }

    return left.id - right.id;
  });
}

// Function ตรวจสอบว่า Shift ของทีมงาน TicketJob หมดแล้วหรือไม่ ถ้าหมดแล้วให้ปล่อย Worker ทั้งทีม
export async function autoReleaseTicketJobWorkersIfShiftEnded(
  ticketJob: Pick<TicketJobDto, "id" | "ticket_number" | "status">,
  actorId: number,
): Promise<void> {
  if (TERMINAL_JOB_STATUSES.includes(ticketJob.status)) {
    return;
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
      return null;
    }

    const hasUnresolvedBooth = tickets.some(
      (ticket) => !SUBMITTED_TICKET_STATUSES.includes(ticket.status),
    );

    if (hasUnresolvedBooth) {
      return null;
    }

    const releasable = sortAssignmentsByAcceptedAt(
      await assignmentRepository.listReleasableAssignmentsByTicketJob(
        ticketJob.id,
        transaction,
      ),
    );

    if (releasable.length === 0) {
      return null;
    }

    const schedules = await Promise.all(
      releasable.map((assignment) =>
        workScheduleRepository.findCurrentByAccountId(assignment.worker_id, transaction),
      ),
    );
    // เช็คว่า Shift ของทีมงานทั้งหมดหมดแล้วหรือยัง ถ้ายังมีคนที่ Shift ยังไม่หมดก็ไม่ปล่อย Worker ทั้งทีม
    const isWholeTeamShiftEnded = schedules.every(
      (schedule) => !schedule || !isTimeInWorkSchedule(schedule),
    );

    if (!isWholeTeamShiftEnded) {
      return null;
    }

    await assignmentRepository.releaseAssignments(
      releasable.map((assignment) => assignment.id),
      new Date(),
      transaction,
    );

    await ticketJobRepository.updateTicketJobStatus(
      ticketJob.id,
      VEHICLE_JOB_STATUS.RELEASED,
      transaction,
    );

    await adminActionLogRepository.create(
      {
        vehicle_job_id: ticketJob.id,
        action_type: ADMIN_ACTION_TYPE.WORKERS_RELEASED,
        reason_code: "auto_released_shift_ended",
        reason_text: "Auto-released after ticket completion submission because a team member's shift already ended.",
        actor_account_id: actorId,
        metadata: {
          worker_ids: releasable.map((assignment) => assignment.worker_id),
        },
      },
      transaction,
    );

    return releasable;
  });

  if (!releasableAssignments) {
    return;
  }

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
    title: "Workers released automatically",
    message: `${releasedWorkerAccountIds.length} worker(s) were auto-released from vehicle job ${ticketJob.ticket_number} after shift end.`,
    payload: {
      ticketNumber: ticketJob.ticket_number,
      reason_code: "auto_released_shift_ended",
      released_worker_codes: releasedWorkerCodes,
    },
    admin: true,
  });
}

// Function ยืนยัน ticket อัตโนมัติเมื่อส่งยอดแล้วแต่ vendor ไม่ยืนยันภายในเวลาจาก config
async function handleVendorConfirmationTimeout(input: {
  ticketId?: number;
  submissionId?: number;
}): Promise<void> {
  if (!input.ticketId || !input.submissionId) {
    return;
  }

  const result = await withTransaction(async (transaction) => {
    const ticket = await boothJobRepository.findBoothJobForCompletion(
      input.ticketId as number,
      transaction
    );

    if (!ticket || ticket.status !== TICKET_STATUS.DELIVERED) {
      return null;
    }

    const submission = await boothJobRepository.findWaitingTicketCompletionSubmission(
      ticket.id,
      transaction
    );

    if (!submission || submission.id !== input.submissionId) {
      return null;
    }

    return applyVendorTicketCompletionResult({
      ticket,
      submission,
      action: "confirm",
      connection: transaction,
    });
  });

  if (!result) {
    return;
  }

  await returnCompletedWorkersToQueue(result.completedTicketJob);

  const ticketPayload = buildWorkerTicketPayload(
    result.ticket,
    result.detail,
    result.products,
    buildTicketCompletionResultExtraFields(result, "vendor_confirm_timeout")
  );

  publishRealtimeEvent({
    type: "TICKET_COMPLETION_RESULT",
    title: "Ticket completion auto-confirmed",
    message: `Ticket ${result.ticket.boothCode} was auto-confirmed after vendor timeout.`,
    payload: { ...ticketPayload },
    worker_payload: { ...ticketPayload },
    admin: true,
    worker_ids: result.receiverAccountIds,
  });
  publishNotification({
    type: "TICKET_COMPLETION_RESULT",
    title: "Ticket completion auto-confirmed",
    message: `Ticket ${result.ticket.boothCode} was auto-confirmed after vendor timeout.`,
    payload: {
      ticket_id: result.ticket.id,
      boothCode: result.ticket.boothCode,
      submission_id: result.submission.id,
      reason: "vendor_confirm_timeout",
    },
    audience: {
      roles: ["admin"],
    },
  });
}

/* -------------------------------------- Shift Handlers -------------------------------------- */

// Function ปิด Shift worker เมื่อถึงเวลาสิ้นสุด และย้าย worker ที่ว่างกลับ open_app
async function handleWorkerShiftEnd(input: {
  workerId: number;
  scheduleId: number;
  shiftInstanceKey?: string;
}): Promise<void> {
  const schedule = await workScheduleRepository.findById(input.scheduleId);

  if (!schedule || schedule.worker_id !== input.workerId) {
    return;
  }

  // ถ้าเวลาปัจจุบันยังอยู่ในช่วง Shift ให้ schedule งานปิด Shift อีกครั้งหลังจาก delay ที่กำหนดไว้ใน Shift
  if (isTimeInWorkSchedule(schedule)) {
    await scheduleWorkerShiftEnd(
      input.workerId,
      input.scheduleId,
      getWorkScheduleShiftEndDelayMs(schedule),
      input.shiftInstanceKey
    );

    return;
  }

  await ejectWorkerForShiftEnd(input.workerId, schedule, input.shiftInstanceKey);
}

// Function ปิด attendance ของ Shift ที่จบแล้วและคืน Worker เป็น open_app
async function ejectWorkerForShiftEnd(
  workerId: number,
  schedule: WorkScheduleDto,
  shiftInstanceKeyInput?: string
): Promise<void> {
  const shiftInstanceKey =
    shiftInstanceKeyInput ?? buildWorkScheduleShiftInstanceKey(schedule);
  const workerCode = await profileRepository.findWorkerCodeByAccountId(workerId);

  await workerCheckinLogRepository.closeWorkerShift(
    {
      worker_id: workerId,
      worker_code: workerCode ?? String(workerId),
      schedule,
      shift_instance_key: shiftInstanceKey,
      reason: "shift_ended",
    }
  );

  const currentAssignment = await assignmentRepository.findCurrentAssignmentByWorker(
    workerId
  );

  if (currentAssignment) {
    const queue = await getWorkerQueueStatus(workerId);

    publishAdminWorkerStatusChanged({
      title: "Worker overtime",
      message: `Worker ${workerCode ?? workerId} shift ended but still has an active assignment.`,
      workerCode,
      queue,
      assignment: currentAssignment,
      reason: "shift_ended_overtime",
    });

    return;
  }

  const queue = await markWorkerOpenApp(workerId);

  if (isWorkerSocketConnected(workerId)) {
    sendWorkerSocketEvent(workerId, "WORKER_STATUS_CHANGED", {
      queue: buildWorkerQueueSocketPayload(queue, workerCode),
      reason: "shift_ended",
    });
  }
  publishAdminWorkerStatusChanged({
    title: "Worker shift closed",
    message: `Worker ${workerCode ?? workerId} moved to open_app because the shift ended.`,
    workerCode,
    queue,
    reason: "shift_ended",
  });
}

// Function พา worker กลับจาก break เข้าคิว หรือกลับ open_app ถ้า socket/shift/assignment ไม่พร้อม
async function handleWorkerBreakReturn(input: {
  workerId: number;
  scheduleId: number;
}): Promise<void> {
  const queueEntry = await getWorkerQueueStatus(input.workerId);

  if (!queueEntry || queueEntry.status !== WORKER_WORK_STATUS.BREAK) {
    return;
  }

  const [currentSchedule, currentAssignment] = await Promise.all([
    workScheduleRepository.findCurrentByAccountId(input.workerId),
    assignmentRepository.findCurrentAssignmentByWorker(input.workerId),
  ]);

  if (currentSchedule) {
    await closeWorkerBreakLog(
      input.workerId,
      buildWorkScheduleShiftInstanceKey(currentSchedule),
      "auto_timeout",
    );
  }

  if (
    currentSchedule &&
    currentSchedule.id === input.scheduleId &&
    isTimeInWorkSchedule(currentSchedule) &&
    !currentAssignment &&
    isWorkerSocketConnected(input.workerId)
  ) {
    const queue = await enqueueWorker(input.workerId);
    const workerCode = await profileRepository.findWorkerCodeByAccountId(input.workerId);
    publishAdminWorkerStatusChanged({
      title: "Worker break finished",
      message: `Worker ${workerCode ?? input.workerId} returned to queue after break.`,
      workerCode,
      queue,
      reason: "break_finished_requeue",
    });
    await dispatchReadyWorkers();
    return;
  }

  const queue = await markWorkerOpenApp(input.workerId);
  const workerCode = await profileRepository.findWorkerCodeByAccountId(input.workerId);
  publishAdminWorkerStatusChanged({
    title: "Worker moved to open_app",
    message: `Worker ${workerCode ?? input.workerId} moved to open_app after break.`,
    workerCode,
    queue,
    reason: "break_finished_not_available",
  });
}

// Function ประมวลผล assignment timeout job หนึ่งตัว (accept/scan/scan_warning/vendor_confirm/mobile_app_*)
// แยกออกมาจาก startAssignmentTimeoutProcessing เพื่อให้ assignment-timeout-sweep (ตาข่ายกันงานที่ค้างเพราะ
// BullMQ job พังไปโดยไม่มี retry) เรียกใช้ตรรกะเดียวกันซ้ำได้อย่างปลอดภัย — safe จะเรียกซ้ำเพราะ
// timeoutAssignment เป็น conditional update (เช็ค status เดิมก่อนเปลี่ยน) ถ้าถูกประมวลผลไปแล้วจะ no-op เฉยๆ
export async function processAssignmentTimeoutJob({
  assignmentId,
  workerId,
  ticketId,
  submissionId,
  mobileAppVersionId,
  kind,
}: AssignmentTimeoutJobData): Promise<void> {
  if (kind === "mobile_app_release_notification") {
    if (mobileAppVersionId) {
      await sendMobileAppReleaseNotification(mobileAppVersionId);
    }
    return;
  }

  if (kind === "mobile_app_force_update_notification") {
    if (mobileAppVersionId) {
      await sendMobileAppForceUpdateNotification(mobileAppVersionId);
    }
    return;
  }

  if (kind === "vendor_confirm") {
    await handleVendorConfirmationTimeout({ ticketId, submissionId });
    return;
  }

  if (!assignmentId || !workerId) {
    return;
  }

  let shouldDispatch = false;
  let capturedAssignment: TicketJobAssignmentDto | null = null;
  let acceptTimeoutResult: AssignmentAcceptTimeoutResult | null = null;
  let scanTimedOut = false;

  // ในทรานแซกชันนี้ทำเฉพาะส่วนที่ต้อง atomic กับการเปลี่ยนสถานะ assignment เท่านั้น (เขียน DB + อ่านที่ใช้
  // ตัดสินใจเขียนต่อ) ส่วน Redis call/notification/การอ่านข้อมูลไปแสดงผลย้ายไปทำหลัง commit ทั้งหมด กันทราน
  // แซกชันถือ connection นานจน Prisma interactive transaction หมดเวลา (ดู incident: getTicketJobTeamScanReadiness
  // ชนกับ transaction timeout ค่า default 5000ms แล้วทำให้ทั้งทรานแซกชัน rollback จนสถานะค้างที่ ACCEPTED)
  await withTransaction(async (transaction) => {
    const assignment = await assignmentRepository.findAssignmentById(
      assignmentId,
      transaction
    );

    if (!assignment) {
      return;
    }

    capturedAssignment = assignment;

    if (kind === "scan") {
      scanTimedOut = await handleAssignmentScanTimeout({
        assignment,
        workerId,
        connection: transaction,
      });
      shouldDispatch = scanTimedOut;
      return;
    }

    if (kind === "scan_warning") {
      await handleAssignmentScanWarning({
        assignment,
        workerId,
        connection: transaction,
      });
      return;
    }

    if (assignment.status !== ASSIGNMENT_STATUS.PENDING) {
      return;
    }

    const timeoutResult = await handleAssignmentAcceptTimeout({
      assignment,
      workerId,
      connection: transaction,
    });

    if (!timeoutResult) {
      // ถ้า assignment ถูก accept หรือ complete ไปแล้วก่อนหน้านี้ ให้ return เพราะไม่ต้องทำอะไรต่อ
      return;
    }

    shouldDispatch = true;
    acceptTimeoutResult = timeoutResult;
  });

  if (shouldDispatch) {
    try {
      await dispatchReadyWorkers();
    } catch (error) {
      logger.error("Dispatch after assignment timeout job failed.", {
        assignmentId,
        workerId,
        kind,
        error,
      });
    }
  }

  // ---- ส่วนหลัง transaction commit แล้ว: Redis queue action + notification ----
  if (acceptTimeoutResult && capturedAssignment) {
    const assignment: TicketJobAssignmentDto = capturedAssignment;
    const result: AssignmentAcceptTimeoutResult = acceptTimeoutResult;
    const queue = await applyAssignmentTimeoutQueueAction(result.queue_action, workerId);
    const ticketJob = await ticketJobRepository.findTicketJobById(assignment.vehicle_job_id);
    const workerCode = await profileRepository.findWorkerCodeByAccountId(workerId);
    const ticketNos = await marketJobRepository.listActiveTicketNosByTicketJobId(
      assignment.vehicle_job_id,
    );

    sendWorkerSocketEvent(workerId, "ASSIGNMENT_TIMEOUT", {
      ticketNumber: ticketJob?.ticket_number ?? null,
      ticketNos,
      reason: result.reason,
      timeout_count: result.timeout_count,
      timeout_limit: result.timeout_limit,
    });
    publishAdminWorkerStatusChanged({
      title: result.closed_shift
        ? "Worker shift closed"
        : result.reason === "assignment_timeout_requeue"
          ? "Worker returned to queue"
          : "Worker moved to open_app",
      message: result.closed_shift
        ? `Worker ${workerCode ?? workerId} moved to open_app after reaching the assignment timeout limit.`
        : result.reason === "assignment_timeout_requeue"
          ? `Worker ${workerCode ?? workerId} returned to queue after assignment timeout.`
          : `Worker ${workerCode ?? workerId} moved to open_app after assignment timeout.`,
      workerCode,
      queue,
      reason: result.reason,
      extraPayload: {
        timeout_count: result.timeout_count,
        timeout_limit: result.timeout_limit,
      },
    });
    publishNotification({
      type: "ASSIGNMENT_TIMEOUT",
      title: "Assignment timed out",
      message: `Worker ${workerCode ?? workerId} did not accept vehicle job ${ticketJob?.ticket_number ?? "-"}.`,
      payload: {
        ticketNumber: ticketJob?.ticket_number ?? null,
        worker_code: workerCode,
        status: ASSIGNMENT_STATUS.TIMEOUT,
        reason: result.reason,
        timeout_count: result.timeout_count,
        timeout_limit: result.timeout_limit,
      },
      audience: {
        roles: ["admin"],
      },
    });
  }

  if (scanTimedOut && capturedAssignment) {
    const assignment: TicketJobAssignmentDto = capturedAssignment;
    await removeScanWarning(assignment.id);
    const queue = await markWorkerOpenApp(workerId);
    const ticketJob = await ticketJobRepository.findTicketJobById(assignment.vehicle_job_id);
    const workerCode = await profileRepository.findWorkerCodeByAccountId(workerId);
    const ticketNos = await marketJobRepository.listActiveTicketNosByTicketJobId(
      assignment.vehicle_job_id,
    );

    sendWorkerSocketEvent(workerId, "ASSIGNMENT_TIMEOUT", {
      ticketNumber: ticketJob?.ticket_number ?? null,
      ticketNos,
      reason: "scan_timeout",
      status: WORKER_WORK_STATUS.OPEN_APP,
    });
    publishAdminWorkerStatusChanged({
      title: "Worker returned to open app",
      message: `Worker ${workerCode ?? workerId} missed QR check-in and returned to open app.`,
      workerCode,
      queue,
      reason: "scan_timeout_open_app",
    });
    publishNotification({
      type: "ASSIGNMENT_TIMEOUT",
      title: "Assignment scan timed out",
      message: `Worker ${workerCode ?? workerId} did not scan QR for vehicle job ${ticketJob?.ticket_number ?? "-"}.`,
      payload: {
        ticketNumber: ticketJob?.ticket_number ?? null,
        worker_code: workerCode,
        status: ASSIGNMENT_STATUS.TIMEOUT,
        reason: "scan_timeout",
      },
      audience: {
        roles: ["admin"],
      },
    });
  }
}

// Function เริ่ม BullMQ worker กลางสำหรับงาน timeout, accept, scan, warning, vendor และ shift งาน
export function startAssignmentTimeoutProcessing(): void {
  startAssignmentTimeoutWorker(processAssignmentTimeoutJob);

  startWorkerBreakReturnWorker(async ({ workerId, scheduleId, shiftInstanceKey, kind }) => {
    if (kind === "shift_end") {
      await handleWorkerShiftEnd({ workerId, scheduleId, shiftInstanceKey });
      return;
    }

    await handleWorkerBreakReturn({ workerId, scheduleId });
  });
}
