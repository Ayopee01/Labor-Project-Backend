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

// Function สร้าง data payload สำหรับยกเลิก TicketWorker จาก Admin action (ต่างจาก cancelDroppedTicketWorkers
// ที่เป็น roster diff sync) — ใช้ร่วมกันทุกจุดที่ Admin สั่งยกเลิก Roster ต่างกันแค่ where clause ว่ายกเลิกขอบเขตไหน
function buildCancelledTicketWorkerData(cancelledAt: Date): Prisma.TicketWorkerUpdateManyMutationInput {
  return {
    status: TICKET_WORKER_STATUS.CANCELLED,
    cancelledAt,
    completedAt: null,
  };
}

// Function ค้นหา TicketWorker หนึ่งแถวของ worker คนหนึ่งใน Business Ticket ใบหนึ่งจาก DB — ใช้หา id
// ก่อนสร้าง BoothJobWorkerExclusion (ต้องใช้ ticketWorkerId เป็น FK ไม่ใช่ workerId ตรงๆ)
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

// Function ดึงสถานะ lock ของ Worker Roster ของ Business Ticket จาก DB — found: false เมื่อไม่มี
// MarketJob แถวนี้อยู่จริง (ต่างจาก found: true + workerRosterLockedAt: null ที่แปลว่ายัง unlock)
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

// Function ดึงรายชื่อ worker (ไม่ซ้ำ) ที่ assignment ยัง active อยู่ (SCANNED_ASSIGNMENT_STATUSES)
// ของ TicketJob คันนี้จาก DB — ใช้เป็น "ทีมปัจจุบัน" สำหรับ decide roster diff ฝั่ง Service
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

// Function สร้างแถว TicketWorker ให้ worker ที่ระบุ (workerIds ตัดสินใจโดย caller แล้วว่าใครขาดจาก
// roster ปัจจุบัน) — skipDuplicates กันชนกรณี concurrent sync ของแผงอื่นในตลาดเดียวกัน
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

// Function ตัดสมาชิก TicketWorker ที่ยัง WORKING แต่ไม่อยู่ใน activeWorkerAccountIds ที่ caller ระบุ
// (worker ออกจากทีมแล้ว) — ไม่แตะแถวที่ถูก Cancel ไว้แล้ว (CANCELLED) หรือ COMPLETED แล้ว
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

// Function ยกเลิก TicketWorker (roster) ที่ยัง WORKING ทั้งหมดของ TicketJob จาก DB — ใช้ตอน Admin ยกเลิกทั้งคัน
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

// Function ยกเลิก TicketWorker (roster) ที่ยัง WORKING ทั้งหมดของ Business Ticket (market job) ใบเดียว จาก DB — ใช้ตอน Admin ยกเลิกทั้งใบ
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

// Function ยกเลิก Worker หนึ่งคนออกจาก Business Ticket (market job) ใบเดียว จาก DB — คืน true ถ้ามีแถวถูกยกเลิกจริง
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

// Function เช็คว่า Worker ยังมีงานที่ทำได้เหลืออยู่บน TicketJob นี้หรือไม่ (ใช้หลัง Admin ถอด Worker ออกจาก Business Ticket/Booth
// เพื่อตัดสินว่าต้องยกเลิก assignment ต่อหรือไม่) — นับเป็นงานเหลือเมื่อมี Business Ticket ที่ยังไม่ปิดซึ่ง:
// - Worker ยังเป็น roster WORKING และมีแผงที่ยังไม่ปิด (รวม DELIVERED/REJECT ที่รอผล Vendor) ที่ไม่ได้ถูกถอดออกอย่างน้อย 1 แผง หรือ
// - Worker ยังไม่มีแถว roster เลยแต่ roster ยังไม่ Lock (ระบบจะ sync เพิ่มเข้าไปภายหลัง) และมีแผงที่ยังไม่ปิด
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
