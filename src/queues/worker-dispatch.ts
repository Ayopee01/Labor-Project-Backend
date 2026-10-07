// Import Config
import { withTransaction } from "../db/prisma";
import { ASSIGNMENT_STATUS, SUBMITTED_TICKET_STATUSES, TERMINAL_JOB_STATUSES, TICKET_STATUS, VEHICLE_JOB_STATUS, WORKER_OPEN_APP_REASON } from "../constants/status";
// Import Repositories
import * as adminActionLogRepository from "../repositories/shared/admin-action-log.repository";
import * as workScheduleRepository from "../repositories/shared/work-schedule.repository";
import * as marketJobRepository from "../repositories/shared/market-job.repository";
import * as masterWorkerRepository from "../repositories/shared/master-worker.repository";
import * as profileRepository from "../repositories/shared/profile.repository";
import * as assignmentRepository from "../repositories/shared/ticket-job-assignment.repository";
import * as boothJobRepository from "../repositories/shared/booth-job.repository";
import * as ticketJobRepository from "../repositories/shared/ticket-job.repository";
import * as workerCheckinLogRepository from "../repositories/shared/worker-checkin-log.repository";
// Import Services
import { getRuntimeSettings } from "../services/shared/runtime-settings.service";
import { closeWorkerBreakLog } from "../services/shared/worker-attendance.service";
import * as ticketJobLifecycleService from "../services/shared/ticket-job-lifecycle.service";
import * as workerAssignmentService from "../services/shared/worker-assignment.service";
import { publishAdminWorkerStatusChanged, publishNotification } from "../services/notifications.service";
import { publishRealtimeEvent } from "../services/shared/realtime-notification.service";
import { publishDriverJobUpdate } from "../services/driver-stream.service";
import { applyVendorTicketCompletionResult, getVendorConfirmationDeadlineMs, publishTicketCompletionResultEvent } from "../services/shared/ticket-completion.service";
import { sendMobileAppForceUpdateNotification, sendMobileAppReleaseNotification } from "../services/shared/mobile-app-version.service";
import { notifyVendorTicketAutoConfirmed } from "../services/shared/vendor-line-notification.service";
// Import Queues
import { clearWorkerPendingBreakReturn, countReadyWorkers, enqueueWorker, enqueueWorkersAtFront, getWorkerPendingBreakReturnScheduleId, getWorkerQueueStatus, markWorkerOpenApp, markWorkerPendingBreakReturn, popReadyWorkers, removeAssignmentTimeout, removeScanTimeout, removeScanWarning, removeWorkerBreakRetryExpiry, scheduleAssignmentTimeout, scheduleScanTimeout, scheduleScanWarning, scheduleWorkerBreakRetryExpiry, scheduleWorkerShiftEnd, startAssignmentTimeoutWorker, startWorkerBreakReturnWorker } from "./worker-queue";
// Import Websockets
import { isWorkerSocketConnected, registerBreakReturnRetryHandler, sendWorkerSocketEvent } from "../websockets/worker.socket";
// Import Types
import type { DbConnection } from "../types/shared/common.type";
import type { AssignmentAcceptTimeoutResult, AssignmentTimeoutJobData, AssignmentTimeoutQueueAction, CompletedWorkerQueueResult, TicketJobAssignmentDto, TicketJobDto, WorkerQueueEntryDto } from "../types/worker.type";
import type { WorkScheduleDto } from "../types/admin-workers.type";
import { ADMIN_ACTION_TYPE } from "../types/shared/admin-action-log.type";
import { WORKER_ASSIGNMENT_EVENT_TYPE } from "../types/shared/worker-assignment-event.type";
import { WORKER_WORK_STATUS } from "../types/shared/worker-status.type";
// Import Utils
import { runWithChildLogContext, setLogContext } from "../utils/log-context";
import { buildWorkScheduleShiftInstanceKey, getWorkScheduleShiftEndDelayMs, isTimeInWorkSchedule } from "../utils/shift";
import { buildTicketCompletionResultExtraFields, buildWorkerTicketPayload } from "../utils/ticket-payload";
import { logger } from "../utils/logger";
import { buildDeadline, getDelayUntil } from "../utils/time";
import { resolveEffectiveWorkersRequired } from "../utils/team-requirement";
import { buildAdminScanDeadlineWarningPayload, buildWorkerAssignedPayload, buildWorkerQueueSocketPayload } from "../utils/worker-payload";

/* -------------------------------------- Config -------------------------------------- */

// Config ส่วนต่างของ deadline ที่ยอมรับได้ก่อนถือว่า config vendor timeout ถูกแก้หลังตั้ง job
const VENDOR_CONFIRM_DEADLINE_TOLERANCE_MS = 5 * 1000;
// Config จำนวนครั้งที่ลองเขียนคิว Redis หลัง accept timeout ก่อนปล่อยให้ sweep กู้สถานะ
const TIMEOUT_QUEUE_ACTION_ATTEMPTS = 3;
// Config ช่วงเวลาที่ sweep ย้อนดู accept timeout เพื่อกู้สถานะคิวที่ค้าง และเวลาเผื่อก่อนถือว่าค้าง
const TIMEOUT_QUEUE_RECONCILE_WINDOW_MS = 30 * 60 * 1000;
const TIMEOUT_QUEUE_RECONCILE_GRACE_MS = 60 * 1000;

/* -------------------------------------- Functions -------------------------------------- */

// Function จ่าย worker สถานะ ready จากคิว Redis FIFO ไปยังงานรถตามลำดับเวลาที่พร้อมจ่ายงาน
export async function dispatchReadyWorkers(
  connection?: Parameters<typeof ticketJobRepository.listDispatchableTicketJobs>[0]
): Promise<void> {
  // งานหน้าคิวต้องได้คนครบก่อน คนไม่พอจะรอ ไม่ข้ามไปจ่ายงานถัดไป
  const settings = await getRuntimeSettings();
  const acceptDeadlineMs = settings.worker_accept_deadline_seconds * 1000;
  const dispatchableJobs = await ticketJobRepository.listDispatchableTicketJobs(connection);

  for (const ticketJob of dispatchableJobs) {
    const result = await runWithChildLogContext(
      { ticketJobId: ticketJob.id, ticketNumber: ticketJob.ticket_number },
      () => dispatchReadyWorkersForTicketJob(ticketJob, acceptDeadlineMs, connection)
    );

    // แจ้ง Driver Web เมื่อมีคนถูกจ่ายงาน (ไม่มี connection = commit แล้ว)
    if (result.assigned && !connection) {
      publishDriverJobUpdate(ticketJob.id, "DRIVER_JOB_UPDATED");
    }

    // งานนี้ยังได้คนไม่ครบ ต้องรอคนในคิวให้ครบก่อน ห้ามข้ามไปจ่ายงานถัดไป
    if (!result.filled) {
      break;
    }
  }
}

// Type ของ TicketJob ที่ dispatch ได้ (ผลลัพธ์จาก listDispatchableTicketJobs)
type DispatchableTicketJob = Awaited<
  ReturnType<typeof ticketJobRepository.listDispatchableTicketJobs>
>[number];

// Type assignment ที่สร้างใน transaction ของ dispatch (ยังไม่ได้ schedule timeout/แจ้งเตือน)
type DispatchCreatedAssignment = {
  assignment: TicketJobAssignmentDto;
  workerId: number;
};

// Type ผลการจ่ายงานให้รถหนึ่งคัน (filled = รถคันนี้มีคนครบแล้ว ไปงานถัดไปได้)
type DispatchTicketJobResult = {
  createdAssignments: DispatchCreatedAssignment[];
  filled: boolean;
};

// Function จ่าย worker ให้งานรถหนึ่งคัน (ถ้า transaction ล้มต้องคืน worker ที่ pop มาแล้วกลับหน้าคิว)
async function dispatchReadyWorkersForTicketJob(
  ticketJob: DispatchableTicketJob,
  acceptDeadlineMs: number,
  connection?: DbConnection
): Promise<{ assigned: boolean; filled: boolean }> {
  const poppedWorkerIds = new Set<number>();
  let result: DispatchTicketJobResult;

  try {
    result = connection
      ? await createDispatchAssignments(ticketJob, acceptDeadlineMs, poppedWorkerIds, connection)
      : await withTransaction((transaction) =>
          createDispatchAssignments(ticketJob, acceptDeadlineMs, poppedWorkerIds, transaction)
        );
  } catch (error) {
    logger.error("Dispatch transaction failed; returning popped workers to the front of the queue.", {
      ticketJobId: ticketJob.id,
      ticketNumber: ticketJob.ticket_number,
      workerIds: [...poppedWorkerIds],
      error,
    });

    try {
      await requeueWorkersAtFrontRespectingShift([...poppedWorkerIds]);
    } catch (requeueError) {
      logger.error("Failed to return popped workers to the queue after dispatch failure.", {
        ticketJobId: ticketJob.id,
        ticketNumber: ticketJob.ticket_number,
        workerIds: [...poppedWorkerIds],
        error: requeueError,
      });
    }

    // จ่ายงานคันนี้ไม่สำเร็จ ถือว่ายังไม่ครบ (กันงานถัดไปแซงคิว)
    return { assigned: false, filled: false };
  }

  if (result.createdAssignments.length === 0) {
    return { assigned: false, filled: result.filled };
  }

  await notifyDispatchedAssignments(ticketJob, result.createdAssignments, acceptDeadlineMs);

  return { assigned: true, filled: result.filled };
}

// Function lock รถ ดึง worker ให้ครบตามจำนวนที่ขาด แล้วสร้าง assignment พร้อมกัน (คนไม่พอไม่สร้างเลย)
async function createDispatchAssignments(
  ticketJob: DispatchableTicketJob,
  acceptDeadlineMs: number,
  poppedWorkerIds: Set<number>,
  connection: DbConnection
): Promise<DispatchTicketJobResult> {
  await connection.$queryRaw`SELECT id FROM ticket_jobs WHERE id = ${ticketJob.id} FOR UPDATE`;

  const activeAssignments = await assignmentRepository.countActiveAssignments(
    ticketJob.id,
    connection
  );
  // หักช่องที่ยังไม่ได้เติม ระบบไม่หาคนแทนให้เอง (Admin เลือกคนเองผ่าน assign-workers)
  const workersNeeded =
    resolveEffectiveWorkersRequired(
      ticketJob.workers_required,
      ticketJob.unfilled_slot_count,
    ) - activeAssignments;

  if (workersNeeded <= 0) {
    return { createdAssignments: [], filled: true };
  }

  const selectedWorkerIds: number[] = [];

  // ทุกคนที่ pop จะถูกเลือกหรือถูกย้ายไป open_app (ลูปจึงจบเสมอ)
  while (selectedWorkerIds.length < workersNeeded) {
    const missingCount = workersNeeded - selectedWorkerIds.length;

    // คนในคิวไม่พอสำหรับรถคันนี้ ไม่ต้อง pop (รอให้คนเข้าคิวครบก่อน)
    if ((await countReadyWorkers()) < missingCount) {
      break;
    }

    const readyWorkers = await popReadyWorkers(missingCount);

    if (readyWorkers.length === 0) {
      break;
    }

    readyWorkers.forEach((worker) => poppedWorkerIds.add(worker.worker_id));

    for (const worker of readyWorkers) {
      // กฎชุดเดียวกับ Admin assign (lock worker หลังงานรถ กันได้งานซ้อนกับ Admin)
      const eligibility = await workerAssignmentService.checkWorkerAssignmentEligibility(
        worker.worker_id,
        connection
      );

      if (eligibility.eligible) {
        selectedWorkerIds.push(worker.worker_id);
        continue;
      }

      // Worker คนนี้ไม่ถูกคืนเข้าคิวถ้า transaction ล้มทีหลัง
      poppedWorkerIds.delete(worker.worker_id);

      if (eligibility.code === "WORKER_OUTSIDE_WORK_SHIFT") {
        await moveOutOfShiftWorkerToOpenApp(worker.worker_id, eligibility.schedule);
        continue;
      }

      // มีงานอยู่แล้ว = สถานะ assigned ถูกต้องอยู่แล้ว ส่วนคนที่ไม่ active ต้องออกจากคิว
      if (eligibility.code !== "WORKER_HAS_ACTIVE_ASSIGNMENT") {
        await markWorkerOpenApp(worker.worker_id);
      }

      logger.warn("Dispatch skipped a queued worker who is not eligible for assignment.", {
        ticketJobId: ticketJob.id,
        workerId: worker.worker_id,
        code: eligibility.code,
      });
    }
  }

  // ได้คนไม่ครบ: คืนคนที่ดึงมาแล้วกลับหน้าคิวตามลำดับเดิม และยังไม่จ่ายงานคันนี้
  if (selectedWorkerIds.length < workersNeeded) {
    if (selectedWorkerIds.length > 0) {
      await requeueWorkersAtFrontRespectingShift(selectedWorkerIds);
      selectedWorkerIds.forEach((workerId) => poppedWorkerIds.delete(workerId));
    }

    return { createdAssignments: [], filled: false };
  }

  const createdAssignments: DispatchCreatedAssignment[] = [];

  for (const workerId of selectedWorkerIds) {
    const assignment = await workerAssignmentService.createAssignmentRound(
      {
        ticketJobId: ticketJob.id,
        workerId,
        acceptDeadlineAt: buildDeadline(acceptDeadlineMs),
      },
      connection
    );

    createdAssignments.push({ assignment, workerId });
  }

  return { createdAssignments, filled: true };
}

// Function ย้าย Worker ที่ pop ออกมาแต่อยู่นอกกะ (หรือไม่มีตารางกะ) ไป open_app พร้อมแจ้งเตือน
async function moveOutOfShiftWorkerToOpenApp(
  workerId: number,
  workerSchedule: WorkScheduleDto | null
): Promise<void> {
  if (workerSchedule) {
    await ejectWorkerForShiftEnd(workerId, workerSchedule);
    return;
  }

  const workerCode = await profileRepository.findWorkerCodeByAccountId(workerId);
  const openAppQueue = await markWorkerOpenApp(workerId);

  if (isWorkerSocketConnected(workerId)) {
    sendWorkerSocketEvent(workerId, "WORKER_STATUS_CHANGED", {
      queue: buildWorkerQueueSocketPayload(openAppQueue, workerCode),
      reason: "no_active_schedule",
    });
  }
  publishAdminWorkerStatusChanged({
    title: "Worker moved to open_app",
    message: `Worker ${workerCode ?? workerId} moved to open_app because no active work schedule was found.`,
    workerCode,
    queue: openAppQueue,
    reason: "no_active_schedule",
  });
}

// Function ตั้ง accept timeout และแจ้งเตือนหลัง dispatch commit (best-effort ทีละคน)
async function notifyDispatchedAssignments(
  ticketJob: DispatchableTicketJob,
  createdAssignments: DispatchCreatedAssignment[],
  acceptDeadlineMs: number
): Promise<void> {
  let workerCodeMap = new Map<number, string | null>();
  let tickets: Awaited<
    ReturnType<typeof marketJobRepository.listActiveTicketSummariesByTicketJobId>
  > = [];

  try {
    [workerCodeMap, tickets] = await Promise.all([
      profileRepository.findWorkerCodeMapByAccountIds(
        createdAssignments.map((created) => created.workerId)
      ),
      marketJobRepository.listActiveTicketSummariesByTicketJobId(ticketJob.id),
    ]);
  } catch (error) {
    logger.error("Failed to load notification data after dispatching workers.", {
      ticketJobId: ticketJob.id,
      ticketNumber: ticketJob.ticket_number,
      error,
    });
  }

  for (const { assignment, workerId } of createdAssignments) {
    const workerCode = workerCodeMap.get(workerId) ?? null;

    try {
      await scheduleAssignmentTimeout(assignment.id, workerId, acceptDeadlineMs);
    } catch (error) {
      logger.error("Failed to schedule accept timeout after dispatch; sweep will time it out.", {
        ticketJobId: ticketJob.id,
        ticketNumber: ticketJob.ticket_number,
        workerId,
        assignmentId: assignment.id,
        error,
      });
    }

    try {
      sendWorkerSocketEvent(
        workerId,
        "WORKER_ASSIGNED",
        buildWorkerAssignedPayload(assignment, ticketJob, tickets)
      );
      publishNotification({
        type: "WORKER_ASSIGNED",
        title: "Worker assigned",
        message: `Worker ${workerCode ?? workerId} was assigned to vehicle job ${ticketJob.ticket_number}.`,
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
        ticketNumber: ticketJob.ticket_number,
        workerId,
        assignmentId: assignment.id,
        error,
      });
    }
  }
}

// Function ตรวจว่า worker ยังกลับเข้าคิวเองได้ (อยู่ในเวลากะและกะยังไม่ถูกปิด)
export async function isWorkerShiftOpenForQueue(
  workerId: number,
  schedule: WorkScheduleDto | null,
  connection?: DbConnection
): Promise<boolean> {
  if (!schedule || !isTimeInWorkSchedule(schedule)) {
    return false;
  }

  const attendance = await workerCheckinLogRepository.findByWorkerAndShift(
    {
      worker_id: workerId,
      shift_instance_key: buildWorkScheduleShiftInstanceKey(schedule),
    },
    connection
  );

  return !attendance?.closedAt;
}

/* -------------------------------------- Timeout Handlers -------------------------------------- */

// Function ประมวลผล assignment accept timeout แบบกัน race
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

  // กะที่ปิดแล้วห้ามกลับเข้าคิวเอง (ต้องให้ Admin force)
  const isShiftClosed =
    hasActiveSchedule &&
    !(await isWorkerShiftOpenForQueue(input.workerId, currentSchedule, input.connection));

  if (isShiftClosed) {
    queueAction = "open_app";
    reason = "assignment_timeout_shift_closed";
  } else if (hasActiveSchedule) {
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

  // คืน action ให้ผู้เรียกเขียน Redis หลัง commit (กัน transaction ค้างนานจนหมดเวลา)
  return {
    queue_action: queueAction,
    reason,
    timeout_count: timeoutCount,
    timeout_limit: settings.worker_accept_timeout_limit,
    closed_shift: closedShift,
  };
}

// Function เขียนคิวใน Redis ตาม action ที่ตัดสินไว้ (เรียกหลัง commit เสมอ และต้องสำเร็จก่อน dispatch)
export async function applyAssignmentTimeoutQueueAction(
  action: AssignmentTimeoutQueueAction,
  workerId: number
): Promise<WorkerQueueEntryDto> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return action === "requeue" ? await enqueueWorker(workerId) : await markWorkerOpenApp(workerId);
    } catch (error) {
      // ลองครบแล้วยังไม่ได้ ให้ sweep กู้สถานะคิวทีหลัง (reconcileTimedOutWorkerQueueStates)
      if (attempt >= TIMEOUT_QUEUE_ACTION_ATTEMPTS) {
        throw error;
      }

      logger.warn("Retrying queue action after assignment accept timeout.", {
        workerId,
        queueAction: action,
        attempt,
        error,
      });
    }
  }
}

// Function คืนคิวให้ worker ที่ accept timeout แล้วแต่ Redis ยังค้าง assigned (สำรองกรณีเขียนคิวหลัง commit ไม่สำเร็จ)
export async function reconcileTimedOutWorkerQueueStates(): Promise<number> {
  const now = Date.now();
  const workerIds = await assignmentRepository.listAcceptTimeoutWorkerIdsBetween(
    new Date(now - TIMEOUT_QUEUE_RECONCILE_WINDOW_MS),
    new Date(now - TIMEOUT_QUEUE_RECONCILE_GRACE_MS)
  );
  let reconciledCount = 0;

  for (const workerId of workerIds) {
    const queue = await getWorkerQueueStatus(workerId);

    // เพิ่งถูกดึงจากคิวไม่นาน = อาจกำลังสร้าง assignment ใหม่อยู่ ห้ามแตะ
    if (
      queue?.status !== WORKER_WORK_STATUS.ASSIGNED ||
      now - new Date(queue.updated_at).getTime() < TIMEOUT_QUEUE_RECONCILE_GRACE_MS ||
      (await assignmentRepository.findBusyWorkerIds([workerId])).size > 0
    ) {
      continue;
    }

    const schedule = await workScheduleRepository.findCurrentByAccountId(workerId);
    const action: AssignmentTimeoutQueueAction =
      (await isWorkerShiftOpenForQueue(workerId, schedule)) ? "requeue" : "open_app";
    const reconciledQueue = await applyAssignmentTimeoutQueueAction(action, workerId);
    const workerCode = await profileRepository.findWorkerCodeByAccountId(workerId);

    reconciledCount += 1;
    logger.warn("Reconciled a worker stuck as assigned after an assignment accept timeout.", {
      workerId,
      queueAction: action,
    });
    sendWorkerSocketEvent(workerId, "WORKER_STATUS_CHANGED", {
      queue: buildWorkerQueueSocketPayload(reconciledQueue, workerCode),
      reason: "assignment_timeout_queue_reconciled",
    });
    publishAdminWorkerStatusChanged({
      title: action === "requeue" ? "Worker returned to queue" : "Worker moved to open_app",
      message: `Worker ${workerCode ?? workerId} queue state was restored after an assignment timeout.`,
      workerCode,
      queue: reconciledQueue,
      reason: "assignment_timeout_queue_reconciled",
    });
  }

  return reconciledCount;
}

// Function แจ้ง Admin เมื่อคนที่เพิ่มมาแทนช่องที่ว่างหมดเวลา (ระบบไม่หาคนแทน ทีมที่เหลือส่งยอดต่อได้)
export async function notifyReplacementWorkerTimeout(
  assignment: TicketJobAssignmentDto,
  reason: "accept_timeout" | "scan_timeout",
): Promise<void> {
  if (!assignment.fills_removed_slot) {
    return;
  }

  const [ticketJob, workerCode] = await Promise.all([
    ticketJobRepository.findTicketJobById(assignment.vehicle_job_id),
    profileRepository.findWorkerCodeByAccountId(assignment.worker_id),
  ]);

  publishNotification({
    type: "REPLACEMENT_WORKER_TIMEOUT",
    title: "Replacement worker timed out",
    message: `Replacement worker ${workerCode ?? assignment.worker_id} did not ${reason === "accept_timeout" ? "accept" : "scan in"} in time for ${ticketJob?.ticket_number ?? "-"}. No replacement was dispatched.`,
    payload: {
      ticketNumber: ticketJob?.ticket_number ?? null,
      worker_code: workerCode,
      reason,
    },
    audience: {
      roles: ["admin"],
    },
  });
}

// Function ประมวลผล assignment scan timeout แบบกัน race
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

  // Redis และแจ้งเตือนทำหลัง commit เพื่อไม่ให้ transaction ค้างนานจนหมดเวลา
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

  const [ticketJob, worker] = await Promise.all([
    ticketJobRepository.findTicketJobById(
      input.assignment.vehicle_job_id,
      input.connection
    ),
    masterWorkerRepository.findById(input.workerId, input.connection),
  ]);
  const remainingSeconds = Math.ceil(remainingDelayMs / 1000);
  const remainingMinutes = Math.ceil(remainingDelayMs / 60000);

  publishNotification({
    type: "ASSIGNMENT_SCAN_DEADLINE_WARNING",
    title: "Worker has not checked in",
    message: `Worker ${worker?.labor_code ?? input.workerId} has not checked in and the scan deadline is near.`,
    payload: buildAdminScanDeadlineWarningPayload({
      assignment: input.assignment,
      ticketJob,
      worker,
      workerStatus: WORKER_WORK_STATUS.ASSIGNED,
      remainingSeconds,
      warningBeforeMinutes: settings.worker_scan_warning_before_minutes,
    }),
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
  const closedBeforeScanWorkerIds = new Set(input?.closed_before_scan_worker_ids ?? []);
  const cancelledWorkerIds = new Set(input?.cancelled_worker_ids ?? []);

  if (
    !input ||
    (input.completed_worker_ids.length === 0 &&
      closedBeforeScanWorkerIds.size === 0 &&
      cancelledWorkerIds.size === 0)
  ) {
    return [];
  }

  // ลบ timeout ที่ค้างของ assignment ที่ปิดก่อน scan
  await Promise.all(
    (input.closed_before_scan_assignment_ids ?? []).flatMap((assignmentId) => [
      removeAssignmentTimeout(assignmentId),
      removeScanTimeout(assignmentId),
      removeScanWarning(assignmentId),
    ])
  );

  const workerIds = [...input.completed_worker_ids, ...closedBeforeScanWorkerIds, ...cancelledWorkerIds];
  const requeuedWorkerCodes: Array<string | null> = [];
  const workerCodeMap = await profileRepository.findWorkerCodeMapByAccountIds(workerIds);

  // worker ที่รถปิดงานก่อน scan ต้องได้ ASSIGNMENT_CANCELLED (มี FCM)
  const notifyWorkerQueueChanged = (
    workerId: number,
    workerCode: string | null,
    queue: WorkerQueueEntryDto,
  ): void => {
    if (closedBeforeScanWorkerIds.has(workerId) || cancelledWorkerIds.has(workerId)) {
      sendWorkerSocketEvent(workerId, "ASSIGNMENT_CANCELLED", {
        ticketNumber: input.vehicle_job.ticket_number,
        // scan แล้วแต่รถถูกยกเลิก = vehicle_job_cancelled (ไม่ใช่งานเสร็จ)
        reason: cancelledWorkerIds.has(workerId)
          ? "vehicle_job_cancelled"
          : "vehicle_job_closed_before_scan",
        worker_status: queue.status,
        queue: buildWorkerQueueSocketPayload(queue, workerCode),
      });
      return;
    }

    if (queue.status === WORKER_WORK_STATUS.READY || isWorkerSocketConnected(workerId)) {
      sendWorkerSocketEvent(workerId, "WORKER_STATUS_CHANGED", {
        queue: buildWorkerQueueSocketPayload(queue, workerCode),
      });
    }
  };

  for (const workerId of workerIds) {
    const workerCode = workerCodeMap.get(workerId) ?? null;
    const [currentSchedule, currentAssignment] = await Promise.all([
      workScheduleRepository.findCurrentByAccountId(workerId),
      assignmentRepository.findCurrentAssignmentByWorker(workerId),
    ]);

    if (currentAssignment) {
      continue;
    }

    const canReturnToQueue = await isWorkerShiftOpenForQueue(workerId, currentSchedule);

    if (canReturnToQueue) {
      const queue = await enqueueWorker(workerId);
      requeuedWorkerCodes.push(workerCode);
      notifyWorkerQueueChanged(workerId, workerCode, queue);
      publishAdminWorkerStatusChanged({
        title: "Worker returned to queue",
        message: cancelledWorkerIds.has(workerId)
          ? `Worker ${workerCode ?? workerId} returned to queue after vehicle job cancellation.`
          : `Worker ${workerCode ?? workerId} returned to queue after vehicle job completion.`,
        workerCode,
        queue,
        reason: cancelledWorkerIds.has(workerId)
          ? "vehicle_job_cancelled_requeue"
          : "vehicle_job_completed_requeue",
        extraPayload: {
          ticketNumber: input.vehicle_job.ticket_number,
        },
      });
      continue;
    }

    const queue = await markWorkerOpenApp(workerId);
    notifyWorkerQueueChanged(workerId, workerCode, queue);
    publishAdminWorkerStatusChanged({
      title: "Worker moved to open_app",
      message: cancelledWorkerIds.has(workerId)
        ? `Worker ${workerCode ?? workerId} moved to open_app after vehicle job cancellation.`
        : `Worker ${workerCode ?? workerId} moved to open_app after vehicle job completion.`,
      workerCode,
      queue,
      reason: cancelledWorkerIds.has(workerId)
        ? "vehicle_job_cancelled_not_available"
        : "vehicle_job_completed_not_available",
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

// Function ลองปิดยอดและปิดงานรถที่ค้างอีกครั้ง ถ้าปิดได้ให้คืน worker เข้าคิวและแจ้ง Driver Web
export async function retryPendingTicketJobClose(ticketJobId: number): Promise<boolean> {
  const completedTicketJob = await ticketJobLifecycleService.closeCompletedTicketJobIfReady(ticketJobId);

  if (!completedTicketJob) {
    return false;
  }

  publishDriverJobUpdate(ticketJobId, "DRIVER_JOB_TERMINAL");
  await returnCompletedWorkersToQueue(completedTicketJob);

  return true;
}

// Function พยายาม requeue worker ที่จบงานกลับเข้าคิวถ้ายังอยู่ใน Shift และ mark open_app ถ้าไม่อยู่ใน Shift
export async function requeueWorkersAtFrontRespectingShift(
  workerIds: number[]
): Promise<{ requeuedWorkerIds: number[]; openAppWorkerIds: number[] }> {
  const candidateWorkerIds = [...new Set(workerIds)];

  if (candidateWorkerIds.length === 0) {
    return { requeuedWorkerIds: [], openAppWorkerIds: [] };
  }

  // คนที่ยังติดงานอื่นใน DB ห้ามคืนเข้าคิว (จะถูกจ่ายงานซ้อน)
  const busyWorkerIds = await assignmentRepository.findBusyWorkerIds(candidateWorkerIds);
  const uniqueWorkerIds = candidateWorkerIds.filter((workerId) => !busyWorkerIds.has(workerId));

  const canReturn = await Promise.all(
    uniqueWorkerIds.map(async (workerId) =>
      isWorkerShiftOpenForQueue(
        workerId,
        await workScheduleRepository.findCurrentByAccountId(workerId),
      ),
    ),
  );

  const requeuedWorkerIds: number[] = [];
  const openAppWorkerIds: number[] = [];

  uniqueWorkerIds.forEach((workerId, index) => {
    if (canReturn[index]) {
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

// Function เรียง assignment ตามเวลากดรับงาน (ไม่มีใช้เวลาสร้าง แล้วตาม id)
export function sortAssignmentsByAcceptedAt(
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
    // Lock แถวรถแล้วอ่านสถานะใหม่ก่อนเขียน RELEASED กัน race กับ Vendor confirm ที่ปิดรถเป็น COMPLETED พร้อมกัน
    await transaction.$queryRaw`SELECT id FROM ticket_jobs WHERE id = ${ticketJob.id} FOR UPDATE`;

    const currentTicketJob = await ticketJobRepository.findTicketJobById(
      ticketJob.id,
      transaction,
    );

    if (!currentTicketJob || TERMINAL_JOB_STATUSES.includes(currentTicketJob.status)) {
      return null;
    }

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
  deadlineMs?: number;
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

    // lock งานรถก่อนอ่านรอบส่งยอด ตามลำดับมาตรฐาน
    await ticketJobRepository.lockTicketJob(ticket.vehicle_job_id, transaction);

    const submission = await boothJobRepository.findWaitingTicketCompletionSubmission(
      ticket.id,
      transaction
    );

    if (!submission || submission.id !== input.submissionId) {
      return null;
    }

    // config ถูกแก้ให้นานขึ้นหลังตั้ง job ยังไม่ตัด ปล่อยให้ job ที่ตั้งใหม่หรือ sweep ตัดตอนครบ deadline
    if (input.deadlineMs !== undefined) {
      const isResubmission = await boothJobRepository.hasRejectedTicketCompletionSubmission(
        ticket.id,
        transaction
      );
      const currentDeadlineMs = await getVendorConfirmationDeadlineMs(submission.created_at, isResubmission);

      if (currentDeadlineMs > input.deadlineMs + VENDOR_CONFIRM_DEADLINE_TOLERANCE_MS) {
        return null;
      }
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

  // แจ้ง Driver Web หลัง commit
  publishDriverJobUpdate(
    result.ticket.vehicle_job_id,
    result.completedTicketJob ? "DRIVER_JOB_TERMINAL" : "DRIVER_JOB_UPDATED",
  );

  await returnCompletedWorkersToQueue(result.completedTicketJob);

  // แจ้ง Vendor ทุกคนในแผงทาง LINE ว่ายืนยันอัตโนมัติแล้ว พร้อมปุ่มให้คะแนน
  await notifyVendorTicketAutoConfirmed({
    ticket: result.ticket,
    submissionId: result.submission.id,
    detail: result.detail,
  });

  const ticketPayload = buildWorkerTicketPayload(
    result.ticket,
    result.detail,
    result.products,
    buildTicketCompletionResultExtraFields(result, "vendor_confirm_timeout")
  );

  publishTicketCompletionResultEvent(result, {
    title: "Ticket completion auto-confirmed",
    message: `Ticket ${result.ticket.boothCode} was auto-confirmed after vendor timeout.`,
    payload: { ...ticketPayload },
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

  // พร้อมกลับเข้าคิวทุกอย่างยกเว้น socket (ใช้แยกว่าควร retry ตอน reconnect หรือไม่)
  const readyToRequeueExceptSocket =
    currentSchedule !== null &&
    currentSchedule.id === input.scheduleId &&
    isTimeInWorkSchedule(currentSchedule) &&
    !currentAssignment;

  if (readyToRequeueExceptSocket && isWorkerSocketConnected(input.workerId)) {
    const queue = await enqueueWorker(input.workerId);
    const workerCode = await profileRepository.findWorkerCodeByAccountId(input.workerId);
    sendWorkerSocketEvent(input.workerId, "WORKER_STATUS_CHANGED", {
      queue: buildWorkerQueueSocketPayload(queue, workerCode),
      reason: "break_finished_requeue",
    });
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

  const queue = await markWorkerOpenApp(
    input.workerId,
    WORKER_OPEN_APP_REASON.BREAK_ENDED_AWAITING_RECONNECT,
  );
  const workerCode = await profileRepository.findWorkerCodeByAccountId(input.workerId);

  // socket ไม่เชื่อมต่อแต่อย่างอื่นพร้อม ตั้ง marker ให้ retry ตอนต่อ socket กลับมา และแจ้งให้เปิดแอป
  if (readyToRequeueExceptSocket && currentSchedule) {
    const settings = await getRuntimeSettings();
    const retryWindowMs = settings.worker_break_retry * 60 * 1000;
    const shiftRemainingMs = getWorkScheduleShiftEndDelayMs(currentSchedule);
    const ttlSeconds = Math.floor(Math.min(retryWindowMs, shiftRemainingMs) / 1000);

    await markWorkerPendingBreakReturn(input.workerId, input.scheduleId, ttlSeconds);
    await scheduleWorkerBreakRetryExpiry(input.workerId, input.scheduleId, ttlSeconds * 1000);
    sendWorkerSocketEvent(
      input.workerId,
      "WORKER_BREAK_RETURN_ACTION_REQUIRED",
      {
        queue: buildWorkerQueueSocketPayload(queue, workerCode),
        reason: "break_finished_not_available",
      },
      { push: true }
    );
  }

  publishAdminWorkerStatusChanged({
    title: "Worker moved to open_app",
    message: `Worker ${workerCode ?? input.workerId} moved to open_app after break.`,
    workerCode,
    queue,
    reason: "break_finished_not_available",
  });
}

// Function พา worker กลับเข้าคิวหลังพักเมื่อต่อ socket กลับมา (เฉพาะมี marker ค้างและยังอยู่กะเดิม)
export async function retryWorkerBreakReturnOnConnect(workerId: number): Promise<void> {
  const pendingScheduleId = await getWorkerPendingBreakReturnScheduleId(workerId);

  if (pendingScheduleId === null) {
    return;
  }

  // ล้าง marker ทันทีกัน retry ซ้ำตอน reconnect ครั้งถัดไป
  await clearWorkerPendingBreakReturn(workerId);
  // worker ต่อ socket กลับมาทันเวลาแล้ว ไม่ต้องแจ้ง "กรุณาติดต่อ Admin" ตอนหน้าต่างเวลาหมดอายุอีก
  await removeWorkerBreakRetryExpiry(workerId, pendingScheduleId);

  const queueEntry = await getWorkerQueueStatus(workerId);

  // reason ต้องยังเป็นรอต่อ socket (ถ้า Admin force open_app หรือปิดกะไปแล้วห้ามดึงกลับเข้าคิว)
  if (
    !queueEntry ||
    queueEntry.status !== WORKER_WORK_STATUS.OPEN_APP ||
    queueEntry.open_app_reason !== WORKER_OPEN_APP_REASON.BREAK_ENDED_AWAITING_RECONNECT
  ) {
    return;
  }

  const [currentSchedule, currentAssignment] = await Promise.all([
    workScheduleRepository.findCurrentByAccountId(workerId),
    assignmentRepository.findCurrentAssignmentByWorker(workerId),
  ]);

  if (
    !currentSchedule ||
    currentSchedule.id !== pendingScheduleId ||
    currentAssignment ||
    !(await isWorkerShiftOpenForQueue(workerId, currentSchedule))
  ) {
    return;
  }

  const queue = await enqueueWorker(workerId);
  const workerCode = await profileRepository.findWorkerCodeByAccountId(workerId);

  sendWorkerSocketEvent(workerId, "WORKER_STATUS_CHANGED", {
    queue: buildWorkerQueueSocketPayload(queue, workerCode),
    reason: "break_finished_requeue_retry",
  });
  publishAdminWorkerStatusChanged({
    title: "Worker break finished (retry)",
    message: `Worker ${workerCode ?? workerId} returned to queue after reconnecting within the same shift.`,
    workerCode,
    queue,
    reason: "break_finished_requeue_retry",
  });
  await dispatchReadyWorkers();
}

// Function แจ้ง worker และ Admin เมื่อหมดเวลารอต่อ socket กลับหลังพัก (สถานะยังเป็น open_app)
async function handleWorkerBreakRetryExpired(input: {
  workerId: number;
  scheduleId: number;
}): Promise<void> {
  // เช็คจากสถานะแทน marker เพราะ marker หมดอายุพร้อม job นี้พอดี (job มักมาช้ากว่าจนอ่าน marker ไม่เจอ)
  const pendingQueue = await getWorkerQueueStatus(input.workerId);

  // reason ไม่ใช่รอต่อ socket แล้ว = worker กลับมาทัน, Admin เปลี่ยนสถานะ หรือหมดกะไปก่อน ไม่ต้องแจ้ง
  if (
    !pendingQueue ||
    pendingQueue.status !== WORKER_WORK_STATUS.OPEN_APP ||
    pendingQueue.open_app_reason !== WORKER_OPEN_APP_REASON.BREAK_ENDED_AWAITING_RECONNECT
  ) {
    return;
  }

  await clearWorkerPendingBreakReturn(input.workerId);

  // เปลี่ยน reason เป็น BREAK_RETRY_EXPIRED
  const queue = await markWorkerOpenApp(
    input.workerId,
    WORKER_OPEN_APP_REASON.BREAK_RETRY_EXPIRED,
  );
  const workerCode = await profileRepository.findWorkerCodeByAccountId(input.workerId);

  sendWorkerSocketEvent(
    input.workerId,
    "WORKER_BREAK_RETRY_EXPIRED",
    {
      queue: buildWorkerQueueSocketPayload(queue, workerCode),
      reason: "break_retry_window_expired",
    },
    { push: true }
  );

  publishAdminWorkerStatusChanged({
    title: "Worker needs admin contact",
    message: `Worker ${workerCode ?? input.workerId} did not return from break within the retry window and may need admin assistance.`,
    workerCode,
    queue,
    reason: "break_retry_window_expired",
  });
}

// Function ประมวลผล timeout job หนึ่งตัว (เรียกซ้ำได้ปลอดภัย ใช้ร่วมกับ assignment-timeout-sweep)
export async function processAssignmentTimeoutJob({
  assignmentId,
  workerId,
  ticketId,
  submissionId,
  deadlineMs,
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
    await handleVendorConfirmationTimeout({ ticketId, submissionId, deadlineMs });
    return;
  }

  if (!assignmentId || !workerId) {
    return;
  }

  let shouldDispatch = false;
  let capturedAssignment: TicketJobAssignmentDto | null = null;
  let acceptTimeoutResult: AssignmentAcceptTimeoutResult | null = null;
  let scanTimedOut = false;

  // transaction ทำเฉพาะงาน DB ที่ต้อง atomic ส่วน Redis และแจ้งเตือนทำหลัง commit
  await withTransaction(async (transaction) => {
    const assignment = await assignmentRepository.findAssignmentById(
      assignmentId,
      transaction
    );

    if (!assignment) {
      return;
    }

    capturedAssignment = assignment;
    setLogContext({ ticketJobId: assignment.vehicle_job_id });

    if (kind === "scan") {
      // scan timeout อาจเปลี่ยนสถานะงานรถ ต้อง lock งานรถก่อน assignment ตามลำดับมาตรฐาน
      await ticketJobRepository.lockTicketJob(assignment.vehicle_job_id, transaction);
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

  const timedOutAssignment = capturedAssignment as TicketJobAssignmentDto | null;

  if (timedOutAssignment && (acceptTimeoutResult || scanTimedOut)) {
    await notifyReplacementWorkerTimeout(
      timedOutAssignment,
      scanTimedOut ? "scan_timeout" : "accept_timeout",
    );
  }

  // หลัง commit: คืนคิว/แจ้งเตือนก่อน แล้วค่อย dispatch (คนที่ timeout ต้องอยู่ท้ายคิวแล้วจึงถูกเรียกซ้ำได้)
  if (acceptTimeoutResult && capturedAssignment) {
    const assignment: TicketJobAssignmentDto = capturedAssignment;
    const result: AssignmentAcceptTimeoutResult = acceptTimeoutResult;
    // DB เป็น TIMEOUT แล้ว Redis ล้มก็ไม่ throw (sweep กู้สถานะคิวให้ภายหลัง)
    let queue: WorkerQueueEntryDto | null = null;

    try {
      queue = await applyAssignmentTimeoutQueueAction(result.queue_action, workerId);
    } catch (error) {
      logger.error("Failed to apply queue action after assignment accept timeout.", {
        assignmentId,
        workerId,
        queueAction: result.queue_action,
        error,
      });
    }
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
    const queue = await markWorkerOpenApp(workerId, WORKER_OPEN_APP_REASON.SCAN_TIMEOUT);
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
}

// Function เริ่ม BullMQ worker กลางสำหรับงาน timeout, accept, scan, warning, vendor และ shift งาน
export function startAssignmentTimeoutProcessing(): void {
  startAssignmentTimeoutWorker(processAssignmentTimeoutJob);

  startWorkerBreakReturnWorker(async ({ workerId, scheduleId, shiftInstanceKey, kind }) => {
    if (kind === "shift_end") {
      await handleWorkerShiftEnd({ workerId, scheduleId, shiftInstanceKey });
      return;
    }

    if (kind === "break_retry_expired") {
      await handleWorkerBreakRetryExpired({ workerId, scheduleId });
      return;
    }

    await handleWorkerBreakReturn({ workerId, scheduleId });
  });

  registerBreakReturnRetryHandler(retryWorkerBreakReturnOnConnect);
}
