// Import Config
import { TICKET_STATUS, TICKET_WORKER_STATUS, WORKING_ASSIGNMENT_STATUSES } from "../../constants/status";
// Import Repositories
import * as boothJobRepository from "../../repositories/shared/booth-job.repository";
import * as masterWorkerRepository from "../../repositories/shared/master-worker.repository";
import * as assignmentRepository from "../../repositories/shared/ticket-job-assignment.repository";
import * as ticketWorkerRepository from "../../repositories/shared/ticket-worker.repository";
import * as workScheduleRepository from "../../repositories/shared/work-schedule.repository";
// Import Types
import { MASTER_WORKER_STATUS } from "../../types/admin-workers.type";
import type { WorkScheduleDto } from "../../types/admin-workers.type";
import type { BoothMembershipRecord } from "../../types/shared/booth-membership.type";
import type { DbConnection } from "../../types/shared/common.type";
import type { TicketJobAssignmentDto } from "../../types/worker.type";
// Import Utils
import { isTimeInWorkSchedule } from "../../utils/shift";

/* -------------------------------------- Types -------------------------------------- */

// Type เหตุผลที่จ่ายงานให้ worker ไม่ได้ (ใช้เป็น error code ฝั่ง Admin)
export type WorkerAssignmentIneligibleCode =
  | "WORKER_NOT_FOUND"
  | "WORKER_NOT_ACTIVE"
  | "WORKER_HAS_ACTIVE_ASSIGNMENT"
  | "WORKER_OUTSIDE_WORK_SHIFT";

// Type ผลตรวจคุณสมบัติก่อนจ่ายงาน
export type WorkerAssignmentEligibility =
  | { eligible: true; schedule: WorkScheduleDto }
  | { eligible: false; code: WorkerAssignmentIneligibleCode; schedule: WorkScheduleDto | null };

/* -------------------------------------- Config -------------------------------------- */

// Config สถานะแผงที่ยังไม่ส่งยอด (คนที่ถูกเรียกกลับรอบใหม่กลับเป็นสมาชิกอัตโนมัติเมื่อ scan)
const REJOIN_OPEN_BOOTH_STATUSES: string[] = [TICKET_STATUS.WAIT, TICKET_STATUS.WORKING];

/* -------------------------------------- Functions -------------------------------------- */

// Function lock worker แล้วตรวจกฎจ่ายงานชุดเดียวของ Auto Dispatch และ Admin (active, ไม่มีงานค้าง, อยู่ในกะ)
export async function checkWorkerAssignmentEligibility(
  workerId: number,
  connection: DbConnection
): Promise<WorkerAssignmentEligibility> {
  // ลำดับ lock มาตรฐาน: ผู้เรียก lock งานรถไว้ก่อนแล้ว จึง lock worker
  await connection.$queryRaw`SELECT id FROM master_workers WHERE id = ${workerId} FOR UPDATE`;

  const worker = await masterWorkerRepository.findById(workerId, connection);

  if (!worker) {
    return { eligible: false, code: "WORKER_NOT_FOUND", schedule: null };
  }

  if (worker.status !== MASTER_WORKER_STATUS.ACTIVE) {
    return { eligible: false, code: "WORKER_NOT_ACTIVE", schedule: null };
  }

  if (await assignmentRepository.findCurrentAssignmentByWorker(workerId, connection)) {
    return { eligible: false, code: "WORKER_HAS_ACTIVE_ASSIGNMENT", schedule: null };
  }

  const schedule = await workScheduleRepository.findCurrentByAccountId(workerId, connection);

  if (!schedule || !isTimeInWorkSchedule(schedule)) {
    return { eligible: false, code: "WORKER_OUTSIDE_WORK_SHIFT", schedule };
  }

  return { eligible: true, schedule };
}

// Function สร้าง assignment รอบใหม่ (row ใหม่ทุกรอบ ประวัติ timeout/reject/cancel รอบก่อนยังอยู่ครบ)
export async function createAssignmentRound(
  input: {
    ticketJobId: number;
    workerId: number;
    acceptDeadlineAt: Date;
    fillsRemovedSlot?: boolean;
  },
  connection: DbConnection
): Promise<TicketJobAssignmentDto> {
  return assignmentRepository.createAssignment(
    input.ticketJobId,
    input.workerId,
    input.acceptDeadlineAt,
    connection,
    input.fillsRemovedSlot ?? false
  );
}

// Function นำคนที่ถูกเรียกกลับรอบใหม่และ scan แล้วกลับเข้า roster และแผงตามกฎ (ยังไม่ส่งยอด = อัตโนมัติ, REJECT = เฉพาะที่ Admin เลือก)
export async function rejoinReturningWorkers(
  marketJobId: number,
  ticketJobId: number,
  connection?: DbConnection
): Promise<void> {
  const scannedAssignments = (
    await assignmentRepository.listActiveAssignmentsByTicketJob(ticketJobId, connection)
  ).filter((assignment) => WORKING_ASSIGNMENT_STATUSES.includes(assignment.status));

  for (const assignment of scannedAssignments) {
    const ticketWorker = await ticketWorkerRepository.findTicketWorkerByMarketJobAndWorkerAccountId(
      marketJobId,
      assignment.worker_id,
      connection
    );

    if (!ticketWorker) {
      continue;
    }

    // คืนเฉพาะสิ่งที่เกิดก่อนรอบนี้ การถอดที่ Admin ทำหลังเริ่มรอบนี้ต้องคงไว้
    const roundStartedAt = new Date(assignment.created_at);

    if (
      ticketWorker.status === TICKET_WORKER_STATUS.CANCELLED &&
      !(await ticketWorkerRepository.reviveTicketWorkerCancelledBefore(
        marketJobId,
        assignment.worker_id,
        roundStartedAt,
        connection
      ))
    ) {
      continue;
    }

    if (ticketWorker.status === TICKET_WORKER_STATUS.COMPLETED) {
      continue;
    }

    await boothJobRepository.deleteBoothJobWorkerExclusionsBefore(
      {
        marketJobId,
        ticketWorkerId: ticketWorker.id,
        boothStatuses: REJOIN_OPEN_BOOTH_STATUSES,
        cancelledBefore: roundStartedAt,
      },
      connection
    );
    await boothJobRepository.deleteBoothJobWorkerExclusionsBefore(
      {
        marketJobId,
        ticketWorkerId: ticketWorker.id,
        boothStatuses: [TICKET_STATUS.REJECT],
        cancelledBefore: roundStartedAt,
        includedWorkerId: assignment.worker_id,
      },
      connection
    );
  }
}

// Function ตรวจว่าคนที่ถูกเรียกกลับรอบใหม่ (ยังไม่ scan) จะกลับเป็นสมาชิกแผงที่ยังไม่ส่งยอดนี้เมื่อ scan
export async function willRejoinOpenBoothOnScan(
  booth: BoothMembershipRecord,
  assignment: TicketJobAssignmentDto,
  connection?: DbConnection
): Promise<boolean> {
  if (!REJOIN_OPEN_BOOTH_STATUSES.includes(booth.status)) {
    return false;
  }

  const rosterMember = booth.roster.find((member) => member.worker_id === assignment.worker_id);

  if (!rosterMember || rosterMember.status === TICKET_WORKER_STATUS.COMPLETED) {
    return false;
  }

  const roundStartedAt = new Date(assignment.created_at);

  if (rosterMember.status === TICKET_WORKER_STATUS.CANCELLED) {
    const ticketWorker = await ticketWorkerRepository.findTicketWorkerByMarketJobAndWorkerAccountId(
      booth.market_job_id,
      assignment.worker_id,
      connection
    );

    if (!ticketWorker?.cancelled_at || new Date(ticketWorker.cancelled_at) >= roundStartedAt) {
      return false;
    }
  }

  const excludedAt = await boothJobRepository.findBoothJobWorkerExclusionCancelledAt(
    booth.id,
    rosterMember.ticket_worker_id,
    connection
  );

  return excludedAt === null || excludedAt < roundStartedAt;
}
