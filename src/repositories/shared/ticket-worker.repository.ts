// Import Library
import { Prisma } from "@prisma/client";
// Import Config
import { SCANNED_ASSIGNMENT_STATUSES, TERMINAL_JOB_STATUSES, TERMINAL_TICKET_STATUSES, TICKET_WORKER_STATUS } from "../../constants/status";
// Import Mappers
import { mapTicketWorker } from "./mappers";
import { client } from "./repository-utils";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";
import type { TicketWorkerDto } from "../../types/worker.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function สร้าง data สำหรับเปลี่ยน TicketWorker เป็น CANCELLED จาก Admin action
function buildCancelledTicketWorkerData(cancelledAt: Date): Prisma.TicketWorkerUpdateManyMutationInput {
  return {
    status: TICKET_WORKER_STATUS.CANCELLED,
    cancelledAt,
    completedAt: null,
  };
}

// Function ค้นหา TicketWorker ของ worker ใน Business Ticket ใบหนึ่ง
export async function findTicketWorkerByMarketJobAndWorkerAccountId(
  marketJobId: number,
  workerId: number,
  connection?: DbConnection
): Promise<TicketWorkerDto | null> {
  const db = client(connection);
  const worker = await db.ticketWorker.findUnique({
    where: {
      marketJobId_workerId: {
        marketJobId,
        workerId,
      },
    },
  });

  return mapTicketWorker(worker);
}

// Function ดึงรายการ worker roster ของ Business Ticket (market job) จาก DB
export async function listTicketWorkers(
  marketJobId: number,
  connection?: DbConnection
): Promise<TicketWorkerDto[]> {
  const db = client(connection);
  const workers = await db.ticketWorker.findMany({
    where: {
      marketJobId,
    },
    orderBy: {
      id: "asc",
    },
  });

  return workers
    .map((worker) => mapTicketWorker(worker))
    .filter((worker): worker is TicketWorkerDto => worker !== null);
}

// Function ดึงสถานะ lock ของ roster (found: false = ไม่มี MarketJob นี้)
export async function findMarketJobRosterLockState(
  marketJobId: number,
  connection?: DbConnection
): Promise<{ found: boolean; workerRosterLockedAt: Date | null }> {
  const db = client(connection);
  const marketJob = await db.marketJob.findUnique({
    where: {
      id: marketJobId,
    },
    select: {
      workerRosterLockedAt: true,
    },
  });

  return marketJob
    ? { found: true, workerRosterLockedAt: marketJob.workerRosterLockedAt }
    : { found: false, workerRosterLockedAt: null };
}

// Function ดึง worker ที่ scan แล้วของงานรถ (ใช้เป็นทีมปัจจุบันตอน sync roster)
export async function listActiveScannedAssignmentWorkerIds(
  ticketJobId: number,
  connection?: DbConnection
): Promise<number[]> {
  const db = client(connection);
  const assignments = await db.ticketJobAssignment.findMany({
    where: {
      ticketJobId,
      status: {
        in: SCANNED_ASSIGNMENT_STATUSES,
      },
    },
    orderBy: {
      id: "asc",
    },
  });

  return [...new Set(assignments.map((assignment) => assignment.workerId))];
}

// Function เพิ่ม worker ที่ยังไม่มีเข้า roster (skipDuplicates กัน sync ซ้อนกัน)
export async function createTicketWorkersIfMissing(
  marketJobId: number,
  workerIds: number[],
  connection?: DbConnection
): Promise<void> {
  if (workerIds.length === 0) {
    return;
  }

  const db = client(connection);

  await db.ticketWorker.createMany({
    data: workerIds.map((workerId) => ({
      marketJobId,
      workerId,
      status: TICKET_WORKER_STATUS.WORKING,
      joinedAt: new Date(),
    })),
    skipDuplicates: true,
  });
}

// Function ยกเลิก roster ของ worker ที่ไม่อยู่ในทีมปัจจุบันแล้ว
export async function cancelDroppedTicketWorkers(
  marketJobId: number,
  activeWorkerAccountIds: number[],
  connection?: DbConnection
): Promise<void> {
  const db = client(connection);

  await db.ticketWorker.updateMany({
    where: {
      marketJobId,
      status: TICKET_WORKER_STATUS.WORKING,
      ...(activeWorkerAccountIds.length > 0
        ? {
          workerId: {
            notIn: activeWorkerAccountIds,
          },
        }
        : {}),
    },
    data: {
      status: TICKET_WORKER_STATUS.CANCELLED,
      cancelledAt: new Date(),
      completedAt: null,
      finalEarningAmount: null,
    },
  });
}

// Function ยกเลิก roster ที่ยัง WORKING ทั้งหมดของงานรถ (Admin ยกเลิกทั้งคัน)
export async function cancelTicketWorkersByTicketJob(
  ticketJobId: number,
  connection?: DbConnection,
): Promise<void> {
  const db = client(connection);

  await db.ticketWorker.updateMany({
    where: {
      status: TICKET_WORKER_STATUS.WORKING,
      marketJob: {
        ticketJobId,
      },
    },
    data: buildCancelledTicketWorkerData(new Date()),
  });
}

// Function ยกเลิก roster ที่ยัง WORKING ทั้งหมดของ Business Ticket ใบเดียว
export async function cancelTicketWorkersByMarketJob(
  marketJobId: number,
  connection?: DbConnection,
): Promise<void> {
  const db = client(connection);

  await db.ticketWorker.updateMany({
    where: {
      status: TICKET_WORKER_STATUS.WORKING,
      marketJobId,
    },
    data: buildCancelledTicketWorkerData(new Date()),
  });
}

// Function ยกเลิก worker หนึ่งคนออกจาก Business Ticket ใบเดียว (คืน true ถ้ายกเลิกจริง)
export async function cancelTicketWorkerForMarketJob(
  marketJobId: number,
  workerId: number,
  connection?: DbConnection,
): Promise<boolean> {
  const db = client(connection);
  const result = await db.ticketWorker.updateMany({
    where: {
      marketJobId,
      workerId,
      status: TICKET_WORKER_STATUS.WORKING,
    },
    data: buildCancelledTicketWorkerData(new Date()),
  });

  return result.count === 1;
}

// Function เช็คว่า worker ยังมีแผงที่ยังไม่จบให้ทำบนงานรถนี้หรือไม่ (รวมแผงที่รอผล Vendor)
export async function hasRemainingWorkOnTicketJob(
  ticketJobId: number,
  workerId: number,
  connection?: DbConnection,
): Promise<boolean> {
  const db = client(connection);
  const marketJobs = await db.marketJob.findMany({
    where: {
      ticketJobId,
      status: {
        notIn: TERMINAL_JOB_STATUSES,
      },
    },
    select: {
      workerRosterLockedAt: true,
      ticketWorkers: {
        where: {
          workerId,
        },
        select: {
          id: true,
          status: true,
        },
      },
      tickets: {
        where: {
          status: {
            notIn: TERMINAL_TICKET_STATUSES,
          },
        },
        select: {
          workerExclusions: {
            select: {
              ticketWorkerId: true,
            },
          },
        },
      },
    },
  });

  return marketJobs.some((marketJob) => {
    const ticketWorker = marketJob.ticketWorkers[0];

    if (!ticketWorker) {
      return marketJob.workerRosterLockedAt === null && marketJob.tickets.length > 0;
    }

    if (ticketWorker.status !== TICKET_WORKER_STATUS.WORKING) {
      return false;
    }

    return marketJob.tickets.some(
      (booth) =>
        !booth.workerExclusions.some(
          (exclusion) => exclusion.ticketWorkerId === ticketWorker.id,
        ),
    );
  });
}
