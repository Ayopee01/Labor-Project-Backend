// Import Config
import { ACTIVE_ASSIGNMENT_STATUSES, ASSIGNMENT_STATUS, SCANNED_ASSIGNMENT_STATUSES, TERMINAL_JOB_STATUSES, TERMINAL_TICKET_STATUSES, TICKET_STATUS, VEHICLE_JOB_STATUS } from "../../constants/status";
import { withTransaction } from "../../db/prisma";
// Import Repositories
import * as driverSessionRepository from "../../repositories/shared/driver-session.repository";
import * as boothJobRepository from "../../repositories/shared/booth-job.repository";
import * as marketJobRepository from "../../repositories/shared/market-job.repository";
import * as ticketWorkerRepository from "../../repositories/shared/ticket-worker.repository";
import * as assignmentRepository from "../../repositories/shared/ticket-job-assignment.repository";
import * as ticketJobRepository from "../../repositories/shared/ticket-job.repository";
import * as workerAssignmentEventRepository from "../../repositories/shared/worker-assignment-event.repository";
// Import Services
import { finalizeMarketJobFinancials } from "./ticket-financial.service";
import { publishRealtimeEvent } from "./realtime-notification.service";
import { rejoinReturningWorkers } from "./worker-assignment.service";
// Import Types
import { WORKER_ASSIGNMENT_EVENT_TYPE } from "../../types/shared/worker-assignment-event.type";
import type { DbConnection } from "../../types/shared/common.type";
import type { CompletedTicketJobResult, CurrentTicketProgressDto, BoothJobDto, MarketJobDto, TicketWorkerDto, TicketJobAssignmentDto, TicketJobDto } from "../../types/worker.type";
// Import Utils
import ApiError from "../../utils/api-error";
import { logger } from "../../utils/logger";

/* -------------------------------------- Config -------------------------------------- */

// Config Business Ticket ที่แจ้ง Admin ไปแล้วว่าปิดยอดไม่สำเร็จ (กันแจ้งซ้ำทุกรอบที่ sweep ลองใหม่)
const notifiedFinalizeFailureMarketJobIds = new Set<number>();

/* -------------------------------------- Functions -------------------------------------- */

// Function ปิดยอด Business Ticket ใน savepoint ข้อมูลไม่พร้อม (ApiError) จะ rollback เฉพาะการปิดยอดแล้วแจ้ง Admin
async function finalizeMarketJobFinancialsInSavepoint(
  marketJobId: number,
  connection: DbConnection,
): Promise<void> {
  await connection.$executeRaw`SAVEPOINT market_job_finalize`;

  try {
    await finalizeMarketJobFinancials(marketJobId, connection);
    await connection.$executeRaw`RELEASE SAVEPOINT market_job_finalize`;
    notifiedFinalizeFailureMarketJobIds.delete(marketJobId);
  } catch (error) {
    // error ระดับ DB ทำให้ทั้ง transaction ใช้ต่อไม่ได้ ต้องโยนต่อ
    if (!(error instanceof ApiError)) {
      throw error;
    }

    await connection.$executeRaw`ROLLBACK TO SAVEPOINT market_job_finalize`;
    logger.error("Market job financialization failed; the booth result is kept and the sweep will retry.", {
      marketJobId,
      code: error.code,
      error,
    });

    if (!notifiedFinalizeFailureMarketJobIds.has(marketJobId)) {
      notifiedFinalizeFailureMarketJobIds.add(marketJobId);
      publishRealtimeEvent({
        type: "MARKET_FINANCIALIZE_FAILED",
        title: "Business ticket financialization failed",
        message: `Business ticket ${marketJobId} could not be financialized: ${error.message}`,
        payload: {
          market_job_id: marketJobId,
          code: error.code,
          reason: error.message,
        },
        admin: true,
      });
    }
  }
}

// Function sync roster ของ Business Ticket ให้ตรงกับทีมที่ scan แล้ว (ข้ามถ้า roster lock แล้ว)
export async function syncTicketWorkerRoster(
  marketJobId: number,
  ticketJobId: number,
  connection?: DbConnection,
): Promise<TicketWorkerDto[]> {
  const lockState = await ticketWorkerRepository.findMarketJobRosterLockState(
    marketJobId,
    connection,
  );

  if (!lockState.found || lockState.workerRosterLockedAt !== null) {
    return ticketWorkerRepository.listTicketWorkers(marketJobId, connection);
  }

  // เพิ่ม roster เฉพาะคนที่ scan แล้ว แต่ไม่ถอดคนที่ยังมีงานบนรถ (คนที่ Admin นำกลับยังไม่ scan ต้องไม่หลุด roster)
  const activeWorkerAccountIds =
    await ticketWorkerRepository.listAssignmentWorkerIdsByStatuses(
      ticketJobId,
      SCANNED_ASSIGNMENT_STATUSES,
      connection,
    );
  const keptWorkerAccountIds =
    await ticketWorkerRepository.listAssignmentWorkerIdsByStatuses(
      ticketJobId,
      [...SCANNED_ASSIGNMENT_STATUSES, ...ACTIVE_ASSIGNMENT_STATUSES],
      connection,
    );
  const existingWorkers = await ticketWorkerRepository.listTicketWorkers(
    marketJobId,
    connection,
  );
  const existingWorkerAccountIds = new Set(
    existingWorkers.map((worker) => worker.worker_id),
  );
  const missingWorkerAccountIds = activeWorkerAccountIds.filter(
    (workerId) => !existingWorkerAccountIds.has(workerId),
  );

  await ticketWorkerRepository.createTicketWorkersIfMissing(
    marketJobId,
    missingWorkerAccountIds,
    connection,
  );
  // คนที่ถูกเรียกกลับรอบใหม่และ scan แล้ว กลับเข้าเฉพาะแผงตามกฎ (แผงที่ส่งยอดแล้วไม่ถูกแตะ)
  await rejoinReturningWorkers(marketJobId, ticketJobId, connection);
  await ticketWorkerRepository.cancelDroppedTicketWorkers(
    marketJobId,
    keptWorkerAccountIds,
    connection,
  );

  return ticketWorkerRepository.listTicketWorkers(marketJobId, connection);
}

// Function sync roster ของทุก Business Ticket ที่ยังเปิดอยู่ของงานรถ (เรียกเมื่อทีมเปลี่ยน)
async function syncAllOpenMarketJobRosters(
  ticketJobId: number,
  connection?: DbConnection,
): Promise<void> {
  const ticketJob = await ticketJobRepository.findTicketJobLifecycleState(
    ticketJobId,
    connection,
  );

  if (!ticketJob) {
    return;
  }

  const openMarketJobs = ticketJob.marketJobs.filter(
    (market) =>
      !TERMINAL_JOB_STATUSES.includes(market.status) &&
      market.workerRosterLockedAt === null,
  );

  for (const market of openMarketJobs) {
    await syncTicketWorkerRoster(market.id, ticketJobId, connection);
  }
}

// Function เปิดแผงถัดไปของงานรถถ้าพร้อม (sync roster และอัปเดตสถานะตามลำดับ)
export async function activateNextTicketIfReady(
  ticketJobId: number,
  connection?: DbConnection,
): Promise<CurrentTicketProgressDto | null> {
  const current = await ticketJobRepository.findCurrentOpenTicketByTicketJob(
    ticketJobId,
    connection,
  );

  if (!current) {
    return null;
  }

  await ticketJobRepository.updateMarketJobStatus(
    current.ticket.market_job_id,
    VEHICLE_JOB_STATUS.WORKING,
    connection,
  );

  const activatableTicketStatuses: string[] = [TICKET_STATUS.WAIT];

  if (!activatableTicketStatuses.includes(current.ticket.status)) {
    await syncAllOpenMarketJobRosters(ticketJobId, connection);

    return current;
  }

  const ticket = await ticketJobRepository.updateBoothJobStatus(
    current.ticket.id,
    TICKET_STATUS.WORKING,
    connection,
  );

  await syncAllOpenMarketJobRosters(ticketJobId, connection);

  return {
    ...current,
    ticket,
  };
}

// Function ตั้งสถานะ Vehicle Job เป็น In Progress แล้วเปิด Ticket แรกที่พร้อมทำงาน
export async function markTicketJobInProgress(
  ticketJobId: number,
  connection?: DbConnection,
): Promise<TicketJobDto> {
  const ticketJob = await ticketJobRepository.markTicketJobInProgress(
    ticketJobId,
    connection,
  );

  await activateNextTicketIfReady(ticketJobId, connection);

  return ticketJob;
}

// Function ปิด Vehicle Job เมื่อทุก Business Ticket จบครบแล้ว (finalize การเงินและปิด session ที่เกี่ยวข้อง)
export async function closeCompletedTicketJobIfReady(
  ticketJobId: number,
  connection?: DbConnection,
): Promise<CompletedTicketJobResult | null> {
  if (!connection) {
    return withTransaction((transaction) =>
      closeCompletedTicketJobIfReady(ticketJobId, transaction),
    );
  }

  // lock งานรถก่อนอ่านสถานะแผง กันแผงสุดท้าย 2 แผงจบพร้อมกันแล้วไม่มีใครปิดยอด
  await connection.$queryRaw`SELECT id FROM ticket_jobs WHERE id = ${ticketJobId} FOR UPDATE`;

  const ticketJob = await ticketJobRepository.findTicketJobLifecycleState(
    ticketJobId,
    connection,
  );

  if (!ticketJob) {
    return null;
  }

  for (const market of ticketJob.marketJobs) {
    const allTicketsTerminal =
      market.tickets.length > 0 &&
      market.tickets.every((ticket) =>
        TERMINAL_TICKET_STATUSES.includes(ticket.status),
      );

    if (allTicketsTerminal && !TERMINAL_JOB_STATUSES.includes(market.status)) {
      const allCancelled = market.tickets.every(
        (ticket) => ticket.status === TICKET_STATUS.CANCELLED,
      );

      if (allCancelled) {
        await ticketJobRepository.updateMarketJobStatus(
          market.id,
          VEHICLE_JOB_STATUS.CANCELLED,
          connection,
        );
      } else {
        // ทุกแผงจบและมีแผง COMPLETED -> ปิดยอดเงินทั้งใบ (ปิดยอดไม่สำเร็จจะไม่ทำให้ผลยืนยันแผงหาย)
        await finalizeMarketJobFinancialsInSavepoint(market.id, connection);
      }
    }
  }

  const refreshedTicketJob =
    await ticketJobRepository.findTicketJobLifecycleState(
      ticketJobId,
      connection,
    );

  if (!refreshedTicketJob) {
    return null;
  }

  // งานรถจบเมื่อทุก Business Ticket จบ และ Gate ปิดรับ Ticket เพิ่มแล้ว (ticketsClosedAt)
  const isVehicleComplete =
    refreshedTicketJob.ticketsClosedAt !== null &&
    refreshedTicketJob.marketJobs.length > 0 &&
    refreshedTicketJob.marketJobs.every(
      (market) =>
        TERMINAL_JOB_STATUSES.includes(market.status) &&
        market.tickets.length > 0 &&
        market.tickets.every((ticket) =>
          TERMINAL_TICKET_STATUSES.includes(ticket.status),
        ),
    );

  if (!isVehicleComplete) {
    return null;
  }

  const vehicleStatus = refreshedTicketJob.marketJobs.every(
    (market) => market.status === VEHICLE_JOB_STATUS.CANCELLED,
  )
    ? VEHICLE_JOB_STATUS.CANCELLED
    : VEHICLE_JOB_STATUS.COMPLETED;
  const wasAlreadyTerminal = TERMINAL_JOB_STATUSES.includes(
    refreshedTicketJob.status,
  );
  const ticketJobDto = wasAlreadyTerminal
    ? await ticketJobRepository.findTicketJobById(ticketJobId, connection)
    : await ticketJobRepository.updateTicketJobStatus(
        ticketJobId,
        vehicleStatus,
        connection,
      );

  if (!wasAlreadyTerminal) {
    // revoke driver session ทั้งหมดเมื่องานรถจบ
    await driverSessionRepository.revokeDriverSessionsByTicketJobId(
      ticketJobId,
      connection,
    );
  }
  const activeAssignments = refreshedTicketJob.assignments.filter(
    (assignment) => ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status),
  );
  // คนที่ scan แล้วปิดเป็น COMPLETED (รถถูกยกเลิก = CANCELLED) ส่วนคนที่ยังไม่ scan ปิดเป็น CANCELLED
  const isVehicleCancelled = vehicleStatus === VEHICLE_JOB_STATUS.CANCELLED;
  const scannedActiveAssignments = activeAssignments.filter(
    (assignment) => SCANNED_ASSIGNMENT_STATUSES.includes(assignment.status),
  );
  const scannedAssignments = isVehicleCancelled ? [] : scannedActiveAssignments;
  const cancelledScannedAssignments = isVehicleCancelled ? scannedActiveAssignments : [];
  const unscannedAssignments = activeAssignments.filter(
    (assignment) => !SCANNED_ASSIGNMENT_STATUSES.includes(assignment.status),
  );
  const completedAssignmentIds = scannedAssignments.map(
    (assignment) => assignment.id,
  );
  const completedWorkerAccountIds = scannedAssignments.map(
    (assignment) => assignment.workerId,
  );

  if (unscannedAssignments.length > 0) {
    await assignmentRepository.cancelAssignmentsClosedBeforeScan(
      unscannedAssignments.map((assignment) => ({
        id: assignment.id,
        worker_id: assignment.workerId,
        vehicle_job_id: assignment.ticketJobId,
      })),
      new Date(),
      connection,
    );
  }

  if (cancelledScannedAssignments.length > 0) {
    await assignmentRepository.cancelScannedAssignmentsForCancelledTicketJob(
      cancelledScannedAssignments.map((assignment) => ({
        id: assignment.id,
        worker_id: assignment.workerId,
        vehicle_job_id: assignment.ticketJobId,
      })),
      new Date(),
      connection,
    );
  }

  if (completedAssignmentIds.length > 0) {
    const completedAt = new Date();

    await assignmentRepository.completeAssignments(
      completedAssignmentIds,
      completedAt,
      connection,
    );
    await workerAssignmentEventRepository.createManyOnce(
      scannedAssignments.map((assignment) => ({
        assignment_id: assignment.id,
        worker_id: assignment.workerId,
        vehicle_job_id: assignment.ticketJobId,
        event_type: WORKER_ASSIGNMENT_EVENT_TYPE.COMPLETED,
        occurred_at: completedAt,
      })),
      connection,
    );
  }

  // คนที่ Admin release ไปก่อนปิดตามรถ แต่ไม่คืนเข้าคิวซ้ำ (กลับคิวไปแล้วตอน release)
  const releasedAssignments = refreshedTicketJob.assignments.filter(
    (assignment) => assignment.status === ASSIGNMENT_STATUS.RELEASED,
  );

  await assignmentRepository.finalizeReleasedAssignments(
    releasedAssignments.map((assignment) => ({
      id: assignment.id,
      worker_id: assignment.workerId,
      vehicle_job_id: assignment.ticketJobId,
    })),
    vehicleStatus === VEHICLE_JOB_STATUS.CANCELLED
      ? ASSIGNMENT_STATUS.CANCELLED
      : ASSIGNMENT_STATUS.COMPLETED,
    new Date(),
    connection,
  );

  return ticketJobDto
    ? {
        vehicle_job: ticketJobDto,
        completed_assignment_ids: completedAssignmentIds,
        completed_worker_ids: completedWorkerAccountIds,
        closed_before_scan_assignment_ids: unscannedAssignments.map((assignment) => assignment.id),
        closed_before_scan_worker_ids: unscannedAssignments.map((assignment) => assignment.workerId),
        cancelled_assignment_ids: cancelledScannedAssignments.map((assignment) => assignment.id),
        cancelled_worker_ids: cancelledScannedAssignments.map((assignment) => assignment.workerId),
      }
    : null;
}

// Function ยกเลิกงานรถทั้งคันพร้อม roster, assignment ที่ active และ MarketJob/BoothJob ที่ยังไม่จบ
export async function cancelTicketJob(
  ticketJobId: number,
  connection?: DbConnection,
): Promise<TicketJobDto> {
  if (!connection) {
    return withTransaction((transaction) =>
      cancelTicketJob(ticketJobId, transaction),
    );
  }

  await ticketWorkerRepository.cancelTicketWorkersByTicketJob(
    ticketJobId,
    connection,
  );
  await assignmentRepository.cancelActiveAssignmentsForTicketJob(
    ticketJobId,
    "admin_vehicle_job_cancel",
    connection,
  );

  return ticketJobRepository.cancelTicketJobWithCascade(
    ticketJobId,
    connection,
  );
}

// Function ยกเลิก assignment ที่ยัง active ทั้งหมดของงานรถพร้อมถอด roster ของคนที่ถูกยกเลิก (ใช้ตอนสั่งรถกลับไป Wait)
export async function cancelActiveAssignmentsForTicketJob(
  ticketJobId: number,
  source: string,
  connection?: DbConnection,
): Promise<TicketJobAssignmentDto[]> {
  const cancelledAssignments =
    await assignmentRepository.cancelActiveAssignmentsForTicketJob(
      ticketJobId,
      source,
      connection,
    );

  // ทีมที่ scan ครบแล้วมี roster อยู่ ต้องถอดออก ไม่งั้นคนที่ถูกคืนคิวจะยังได้ค่าแรงแผงนี้
  if (cancelledAssignments.length > 0) {
    await syncAllOpenMarketJobRosters(ticketJobId, connection);
  }

  return cancelledAssignments;
}

// Function ยกเลิก Business Ticket ทั้งใบพร้อม roster และแผงที่ยังไม่จบ
export async function cancelMarketJob(
  marketJobId: number,
  connection?: DbConnection,
): Promise<MarketJobDto> {
  await ticketWorkerRepository.cancelTicketWorkersByMarketJob(
    marketJobId,
    connection,
  );

  return marketJobRepository.cancelMarketJobWithCascade(
    marketJobId,
    connection,
  );
}

// Function ยกเลิกแผงเดียว (ไม่แตะ roster เพราะ worker ยังทำแผงอื่นในใบเดียวกันได้)
export async function cancelBoothJob(
  ticketId: number,
  connection?: DbConnection,
): Promise<BoothJobDto> {
  return boothJobRepository.cancelBoothJob(ticketId, connection);
}

// Function คืน assignment ที่ค้าง REJECT เป็น WORKING เมื่อรถที่ยังเปิดอยู่ไม่เหลือแผง REJECT แล้ว (หลังยกเลิกแผง/ตลาด)
export async function clearRejectStateIfNoRejectedBooth(
  ticketJobId: number,
  connection: DbConnection,
): Promise<void> {
  const ticketJob = await ticketJobRepository.findTicketJobById(ticketJobId, connection);

  if (!ticketJob || TERMINAL_JOB_STATUSES.includes(ticketJob.status)) {
    return;
  }

  const hasRejectedBooth = await boothJobRepository.hasRejectedBoothForTicketJob(
    ticketJobId,
    connection,
  );

  if (!hasRejectedBooth) {
    await assignmentRepository.resetRejectedAssignmentsToWorking(ticketJobId, connection);
  }
}

// Function ยกเลิก worker ออกจาก roster ของ Business Ticket ใบเดียว (ไม่แตะ assignment)
export async function cancelTicketWorkerForMarketJob(
  marketJobId: number,
  workerId: number,
  connection?: DbConnection,
): Promise<boolean> {
  return ticketWorkerRepository.cancelTicketWorkerForMarketJob(
    marketJobId,
    workerId,
    connection,
  );
}
