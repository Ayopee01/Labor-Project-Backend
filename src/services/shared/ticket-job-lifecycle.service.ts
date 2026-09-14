// Import Config
import { ACTIVE_ASSIGNMENT_STATUSES, TERMINAL_JOB_STATUSES, TERMINAL_TICKET_STATUSES, TICKET_STATUS, VEHICLE_JOB_STATUS } from "../../constants/status";
import { withTransaction } from "../../db/prisma";
// Import Types
import { WORKER_ASSIGNMENT_EVENT_TYPE } from "../../types/shared/worker-assignment-event.type";
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
// Import Types
import type { DbConnection } from "../../types/shared/common.type";
import type { CompletedTicketJobResult, CurrentTicketProgressDto, BoothJobDto, MarketJobDto, TicketWorkerDto, TicketJobAssignmentDto, TicketJobDto } from "../../types/worker.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function Sync Worker Roster ของ Business Ticket ใบเดียวให้ตรงกับทีม Worker ปัจจุบัน
// ตัดสินใจ roster diff เอง (ใครขาด/ใครหลุดทีม) แล้วสั่ง Repository persist (diff/lock decision เป็น business logic)
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

  const activeWorkerAccountIds =
    await ticketWorkerRepository.listActiveScannedAssignmentWorkerIds(
      ticketJobId,
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
  await ticketWorkerRepository.cancelDroppedTicketWorkers(
    marketJobId,
    activeWorkerAccountIds,
    connection,
  );

  return ticketWorkerRepository.listTicketWorkers(marketJobId, connection);
}

// Function Sync Worker Roster ของทุก Business Ticket ที่ยัง Active และยังไม่ Lock ของ TicketNumber นี้
// เรียกทุกครั้งที่ทีมเปลี่ยน (Ticket ใหม่มา, Worker accept/scan ใหม่) เพื่อให้สมาชิกใหม่ถูกเพิ่มเข้า Ticket อื่นที่เปิดอยู่ด้วย
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

// Function เปิด Ticket ถัดไปของ Vehicle Job นี้ถ้าพร้อม (sync roster และอัปเดตสถานะ Business Ticket/Ticket ตามลำดับ)
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

  // Lock แถว TicketJob นี้ก่อนอ่านสถานะ Booth ทั้งหมด กัน Race ตอน 2 Booth สุดท้ายจบพร้อมกันคนละ Transaction
  // (ไม่ Lock แล้วทั้งคู่จะอ่านเห็น "ยังไม่ครบ" พร้อมกัน ไม่มีใคร Finalize เลย) บังคับให้ Transaction หลังรอ Transaction แรก Commit ก่อน
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
        // อย่างน้อยหนึ่ง Booth COMPLETED และทุก Booth Terminal แล้ว -> Lock Roster และ Finalize การเงินทั้งใบ
        // (finalizeMarketJobFinancials จะเซ็ต MarketJob.status = COMPLETED เอง)
        await finalizeMarketJobFinancials(market.id, connection);
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

  // TicketNumber จบได้ต่อเมื่อทุก Business Ticket Terminal ครบ "และ" Gate ยืนยันแล้วว่าไม่มี Business Ticket เพิ่มอีก (ticketsClosedAt)
  // ห้ามใช้แค่ Ticket ที่เห็นตอนนี้ครบ เพราะ Gate อาจยังส่ง Ticket ใหม่มาอีกได้
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
    // เพิกถอน driver session ที่ยัง active ทั้งหมดทันทีที่ TicketNumber จบ เพราะคนขับไม่ต้องเปิดหน้า driver ต่อแล้ว
    await driverSessionRepository.revokeDriverSessionsByTicketJobId(
      ticketJobId,
      connection,
    );
  }
  const activeAssignments = refreshedTicketJob.assignments.filter(
    (assignment) => ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status),
  );
  const completedAssignmentIds = activeAssignments.map(
    (assignment) => assignment.id,
  );
  const completedWorkerAccountIds = activeAssignments.map(
    (assignment) => assignment.workerId,
  );

  if (completedAssignmentIds.length > 0) {
    const completedAt = new Date();

    await assignmentRepository.completeAssignments(
      completedAssignmentIds,
      completedAt,
      connection,
    );
    await workerAssignmentEventRepository.createManyOnce(
      activeAssignments.map((assignment) => ({
        assignment_id: assignment.id,
        worker_id: assignment.workerId,
        vehicle_job_id: assignment.ticketJobId,
        event_type: WORKER_ASSIGNMENT_EVENT_TYPE.COMPLETED,
        occurred_at: completedAt,
      })),
      connection,
    );
  }

  return ticketJobDto
    ? {
        vehicle_job: ticketJobDto,
        completed_assignment_ids: completedAssignmentIds,
        completed_worker_ids: completedWorkerAccountIds,
      }
    : null;
}

// Function ยกเลิก vehicle job ทั้งคัน — cascade ยกเลิก TicketWorker roster, TicketJobAssignment ที่ยัง active,
// และ MarketJob/BoothJob ที่ยังไม่ terminal (ตัดสินใจ cascade ที่นี่ ส่วน repository ทำแค่เขียนทีละ table)
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

// Function ยกเลิก assignment ที่ยัง active ทั้งหมดของ TicketJob โดยไม่แตะ TicketWorker/MarketJob/BoothJob/TicketJob เอง (ต่างจาก cancelTicketJob ที่ยกเลิกทั้งคัน)
// ใช้เมื่อ Admin สั่งกลับไป Wait ก่อนทีมเริ่มทำงานจริง จึงไม่มี TicketWorker roster ให้ต้องยกเลิก
export async function cancelActiveAssignmentsForTicketJob(
  ticketJobId: number,
  connection?: DbConnection,
): Promise<TicketJobAssignmentDto[]> {
  return assignmentRepository.cancelActiveAssignmentsForTicketJob(
    ticketJobId,
    "admin_vehicle_job_wait",
    connection,
  );
}

// Function ยกเลิก Business Ticket (market job) ทั้งใบ — cascade ยกเลิก TicketWorker roster ของใบนี้
// และ BoothJob ที่ยังไม่ terminal ภายใต้ใบนี้
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

// Function ยกเลิก Gate ticket (booth) เดียว — ไม่ cascade ไป TicketWorker เพราะ Roster เป็นระดับ Business
// Ticket (market job) ไม่ใช่ระดับ Booth การยกเลิก Booth เดียวไม่ควรกระทบสมาชิกที่ยังทำ Booth อื่นในใบเดียวกัน
export async function cancelBoothJob(
  ticketId: number,
  connection?: DbConnection,
): Promise<BoothJobDto> {
  return boothJobRepository.cancelBoothJob(ticketId, connection);
}

// Function ยกเลิก Worker หนึ่งคนออกจาก Business Ticket (market job) ใบเดียว — ต่างจาก cancelAssignment: ไม่แตะ TicketJobAssignment เลย
// (worker ยังอยู่กับรถ/TicketNumber และยังทำ Business Ticket อื่นได้) กระทบเฉพาะ Roster ของใบนี้ใบเดียว
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
