// Import Library
import type { Prisma } from "@prisma/client";
// Import Config
import { ASSIGNMENT_STATUS, SCANNED_ASSIGNMENT_STATUSES, TICKET_JOB_ENTRY_MODE, TICKET_STATUS, TICKET_SUBMITTER_ROLE, TICKET_WORKER_STATUS, VEHICLE_JOB_STATUS } from "../constants/status";
// Import Repositories
import { client, createRandomToken } from "./shared/repository-utils";
// Import Types
import type { AdminManualJobListRecord, AdminManualJobRecord } from "../types/admin-jobs.type";
import type { DbConnection } from "../types/shared/common.type";
import { ADMIN_ACTION_TYPE } from "../types/shared/admin-action-log.type";

/* -------------------------------------- Config -------------------------------------- */

// Config include ของงานบันทึกย้อนหลังพร้อมแผง สินค้า ยอดเงิน และ worker ที่ได้เงิน
const MANUAL_JOB_RECORD_INCLUDE = {
  marketJobs: {
    orderBy: { id: "asc" as const },
    include: {
      tickets: {
        orderBy: { id: "asc" as const },
        include: {
          products: {
            orderBy: { id: "asc" as const },
            include: {
              financial: {
                include: {
                  workerPayments: {
                    include: { ticketWorker: { include: { worker: true } } },
                  },
                },
              },
            },
          },
          workerSnapshots: {
            orderBy: { id: "asc" as const },
            include: { ticketWorker: { include: { worker: true } } },
          },
        },
      },
    },
  },
};

/* -------------------------------------- Functions -------------------------------------- */

// Function ดึงรายการงานบันทึกย้อนหลังตามช่วงวันที่ทำงาน (เรียงงานล่าสุดก่อน) พร้อมจำนวนทั้งหมด
export async function listManualJobs(
  filters: { startAt: Date; endAt: Date; search?: string; page: number; limit: number },
  connection?: DbConnection
): Promise<{ records: AdminManualJobListRecord[]; total: number }> {
  const db = client(connection);
  const contains = filters.search ? { contains: filters.search, mode: "insensitive" as const } : null;
  const where: Prisma.TicketJobWhereInput = {
    entryMode: TICKET_JOB_ENTRY_MODE.MANUAL,
    workStartedAt: { gte: filters.startAt, lt: filters.endAt },
    ...(contains && {
      OR: [
        { ticketNumber: contains },
        { licensePlate: contains },
        { marketJobs: { some: { ticketNo: contains } } },
      ],
    }),
  };
  const [records, total] = await Promise.all([
    db.ticketJob.findMany({
      where,
      orderBy: [{ workStartedAt: "desc" }, { id: "desc" }],
      skip: (filters.page - 1) * filters.limit,
      take: filters.limit,
      include: {
        marketJobs: {
          orderBy: { id: "asc" },
          select: {
            ticketNo: true,
            finalStallAmount: true,
            tickets: { select: { products: { select: { stallFeeRounded: true } } } },
            _count: { select: { tickets: true } },
            ticketWorkers: { select: { finalEarningAmount: true } },
          },
        },
        _count: { select: { assignments: true } },
        // การบันทึก/แก้ไขล่าสุดของงาน
        adminActionLogs: {
          where: {
            actionType: { in: [ADMIN_ACTION_TYPE.MANUAL_JOB_CREATED, ADMIN_ACTION_TYPE.MANUAL_JOB_UPDATED] },
          },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
          include: { actor: { select: { fullName: true } } },
        },
      },
    }),
    db.ticketJob.count({ where }),
  ]);

  return { records, total };
}

// Function อ่านงานรถพร้อมข้อมูลที่ใช้สร้าง response ของงานบันทึกย้อนหลัง
export async function findManualJobRecordById(
  ticketJobId: number,
  connection?: DbConnection
): Promise<AdminManualJobRecord | null> {
  return client(connection).ticketJob.findUnique({
    where: { id: ticketJobId },
    include: MANUAL_JOB_RECORD_INCLUDE,
  });
}

// Function lock งานรถตาม TicketNumber แล้วอ่านพร้อมข้อมูลงานบันทึกย้อนหลัง (กันแก้ไข/ลบพร้อมกัน)
export async function lockAndFindManualJobRecordByRef(
  ticketNumber: string,
  connection?: DbConnection
): Promise<AdminManualJobRecord | null> {
  const db = client(connection);

  await db.$queryRaw`SELECT id FROM ticket_jobs WHERE ticket_number = ${ticketNumber} FOR UPDATE`;

  return db.ticketJob.findUnique({
    where: { ticketNumber },
    include: MANUAL_JOB_RECORD_INCLUDE,
  });
}

// Function อ่านงานรถตาม TicketNumber พร้อมข้อมูลงานบันทึกย้อนหลัง
export async function findManualJobRecordByRef(
  ticketNumber: string,
  connection?: DbConnection
): Promise<AdminManualJobRecord | null> {
  return client(connection).ticketJob.findUnique({
    where: { ticketNumber },
    include: MANUAL_JOB_RECORD_INCLUDE,
  });
}

// Function ตรวจว่าเลขนี้ถูกใช้เป็น TicketNumber ของงานรถอื่นแล้วหรือไม่ (ไม่นับงานรถที่ระบุ)
export async function isTicketNumberTaken(
  number: string,
  excludeTicketJobId: number | null,
  connection?: DbConnection
): Promise<boolean> {
  const ticketJob = await client(connection).ticketJob.findUnique({
    where: { ticketNumber: number },
    select: { id: true },
  });

  return ticketJob !== null && ticketJob.id !== excludeTicketJobId;
}

// Function ตรวจว่าเลขนี้ถูกออกเป็น TicketNo แล้วหรือไม่ (รวมตั๋วที่ยกเลิกแล้ว)
export async function isTicketNoTaken(
  number: string,
  connection?: DbConnection
): Promise<boolean> {
  const marketJob = await client(connection).marketJob.findUnique({
    where: { ticketNo: number },
    select: { id: true },
  });

  return marketJob !== null;
}

// Function ดึง worker ตาม LaborCode (ทุกสถานะ เพราะ worker อาจลาออกก่อนมาบันทึกย้อนหลัง)
export async function listWorkersByLaborCodes(
  laborCodes: string[],
  connection?: DbConnection
): Promise<Array<{ id: number; laborCode: string; fullName: string | null }>> {
  return client(connection).masterWorker.findMany({
    where: { laborCode: { in: laborCodes } },
    select: { id: true, laborCode: true, fullName: true },
  });
}

// Function ดึง assignment ที่ worker ทำงานจริงในงานรถอื่นซึ่งช่วงเวลาทับกับช่วงที่ระบุ
export async function listOverlappingWorkedAssignments(
  workerIds: number[],
  startAt: Date,
  endAt: Date,
  excludeTicketJobId: number | null,
  connection?: DbConnection
): Promise<Array<{
  workerCode: string;
  ticketNumber: string;
  startedAt: Date;
  endedAt: Date | null;
}>> {
  const assignments = await client(connection).ticketJobAssignment.findMany({
    where: {
      workerId: { in: workerIds },
      status: { in: SCANNED_ASSIGNMENT_STATUSES },
      createdAt: { lt: endAt },
      AND: [
        { OR: [{ completedAt: null }, { completedAt: { gt: startAt } }] },
        { OR: [{ releasedAt: null }, { releasedAt: { gt: startAt } }] },
      ],
      ...(excludeTicketJobId !== null && { ticketJobId: { not: excludeTicketJobId } }),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    include: {
      worker: { select: { laborCode: true } },
      ticketJob: { select: { ticketNumber: true } },
    },
  });

  return assignments.map((assignment) => ({
    workerCode: assignment.worker.laborCode,
    ticketNumber: assignment.ticketJob.ticketNumber,
    startedAt: assignment.scannedAt ?? assignment.acceptedAt ?? assignment.createdAt,
    endedAt: assignment.releasedAt ?? assignment.completedAt,
  }));
}

// Function สร้างงานรถของงานบันทึกย้อนหลัง (ปิดรับตั๋วและจบงานแล้ว ไม่เข้า dispatch)
export async function createManualTicketJob(
  data: {
    ticketNumber: string;
    licensePlate: string;
    licensePlateProvince: string;
    vehicleType: string | null;
    vehicleTypeCode: string | null;
    workersRequired: number;
    workStartedAt: Date;
    completedAt: Date;
  },
  connection?: DbConnection
): Promise<{ id: number }> {
  return client(connection).ticketJob.create({
    data: {
      ...data,
      entryMode: TICKET_JOB_ENTRY_MODE.MANUAL,
      status: VEHICLE_JOB_STATUS.COMPLETED,
      dispatchNow: false,
      driverQrToken: createRandomToken("driver_qr"),
      ticketsClosedAt: data.workStartedAt,
      createdAt: data.workStartedAt,
    },
    select: { id: true },
  });
}

// Function แก้ข้อมูลงานรถของงานบันทึกย้อนหลังในแถวเดิม (id คงเดิม)
export async function updateManualTicketJob(
  ticketJobId: number,
  data: {
    ticketNumber: string;
    licensePlate: string;
    licensePlateProvince: string;
    vehicleType: string | null;
    vehicleTypeCode: string | null;
    workersRequired: number;
    workStartedAt: Date;
    completedAt: Date;
  },
  connection?: DbConnection
): Promise<void> {
  await client(connection).ticketJob.update({
    where: { id: ticketJobId },
    data: {
      ...data,
      ticketsClosedAt: data.workStartedAt,
      createdAt: data.workStartedAt,
    },
  });
}

// Function สร้าง Business Ticket ของงานบันทึกย้อนหลัง (WORKING จนกว่าจะปิดยอด)
export async function createManualMarketJob(
  data: {
    ticketJobId: number;
    ticketNo: string;
    boothCount: number;
    workersRequired: number;
    marketCode: string;
    marketName: string;
    dropoffPoint: string;
    gateNo: string | null;
    workStartedAt: Date;
  },
  connection?: DbConnection
): Promise<{ id: number }> {
  const { workStartedAt, ...marketJob } = data;

  return client(connection).marketJob.create({
    data: {
      ...marketJob,
      ticketCreatedAt: workStartedAt,
      gateTransactionRef: `MANUAL-${data.ticketNo}`,
      status: VEHICLE_JOB_STATUS.WORKING,
      createdAt: workStartedAt,
    },
    select: { id: true },
  });
}

// Function สร้าง roster ของ Business Ticket (WORKING จนกว่าจะปิดยอด)
export async function createManualTicketWorkers(
  marketJobId: number,
  workerIds: number[],
  joinedAt: Date,
  connection?: DbConnection
): Promise<Map<number, number>> {
  const db = client(connection);
  const ticketWorkerIdByWorkerId = new Map<number, number>();

  for (const workerId of workerIds) {
    const ticketWorker = await db.ticketWorker.create({
      data: {
        marketJobId,
        workerId,
        status: TICKET_WORKER_STATUS.WORKING,
        joinedAt,
        createdAt: joinedAt,
      },
      select: { id: true },
    });

    ticketWorkerIdByWorkerId.set(workerId, ticketWorker.id);
  }

  return ticketWorkerIdByWorkerId;
}

// Function สร้างแผงที่ยืนยันยอดแล้ว
export async function createManualBoothJob(
  data: {
    ticketJobId: number;
    marketJobId: number;
    boothCode: string;
    boothName: string | null;
    vendorLineId: string | null;
    workStartedAt: Date;
    completedAt: Date;
  },
  connection?: DbConnection
): Promise<{ id: number }> {
  const { workStartedAt, ...boothJob } = data;

  return client(connection).boothJob.create({
    data: {
      ...boothJob,
      status: TICKET_STATUS.COMPLETED,
      createdAt: workStartedAt,
    },
    select: { id: true },
  });
}

// Function ตั้งจำนวนที่ยืนยันของทุกสินค้าในแผงเท่ากับจำนวนที่บันทึก
export async function confirmManualBoothProductQuantities(
  boothJobId: number,
  connection?: DbConnection
): Promise<void> {
  await client(connection).$executeRaw`
    UPDATE ticket_products SET confirmed_quantity = quantity WHERE ticket_id = ${boothJobId}
  `;
}

// Function สร้างรอบส่งยอดที่ยืนยันแล้ว พร้อม snapshot worker ของรอบนั้นและตัวหารเงินของแผง
export async function createManualBoothSubmission(
  data: {
    boothJobId: number;
    actorAccountId: number;
    ticketWorkerIds: number[];
    completedAt: Date;
  },
  connection?: DbConnection
): Promise<void> {
  const db = client(connection);
  const submission = await db.ticketCompletionSubmission.create({
    data: {
      ticketId: data.boothJobId,
      submittedByAccountId: data.actorAccountId,
      submittedByRole: TICKET_SUBMITTER_ROLE.ADMIN,
      status: TICKET_STATUS.COMPLETED,
      confirmedAt: data.completedAt,
      workerCountSnapshot: data.ticketWorkerIds.length,
      createdAt: data.completedAt,
    },
    select: { id: true },
  });

  await db.workerSnapshot.createMany({
    data: data.ticketWorkerIds.flatMap((ticketWorkerId) => [
      { submissionId: submission.id, ticketWorkerId },
      { boothJobId: data.boothJobId, ticketWorkerId },
    ]),
  });
}

// Function สร้าง assignment ที่จบงานแล้วของ worker ทุกคนบนรถ (ใช้แสดงประวัติงานของ worker)
export async function createManualAssignments(
  ticketJobId: number,
  workerIds: number[],
  workStartedAt: Date,
  completedAt: Date,
  connection?: DbConnection
): Promise<void> {
  await client(connection).ticketJobAssignment.createMany({
    data: workerIds.map((workerId) => ({
      ticketJobId,
      workerId,
      status: ASSIGNMENT_STATUS.COMPLETED,
      acceptedAt: workStartedAt,
      scannedAt: workStartedAt,
      completedAt,
      createdAt: workStartedAt,
    })),
  });
}

// Function ลบข้อมูลใต้งานรถทั้งหมด (ตลาด แผง สินค้า ยอดเงิน roster assignment) โดยคง log ของ Admin ไว้
export async function deleteTicketJobChildren(
  ticketJobId: number,
  connection?: DbConnection
): Promise<void> {
  const db = client(connection);
  const boothJobIds = (
    await db.boothJob.findMany({ where: { ticketJobId }, select: { id: true } })
  ).map((booth) => booth.id);
  const marketJobIds = (
    await db.marketJob.findMany({ where: { ticketJobId }, select: { id: true } })
  ).map((market) => market.id);

  // log ของ Admin เป็นหลักฐานถาวร จึงตัดการอ้างอิงตลาด/แผงที่จะถูกลบแทนการลบ log
  await db.adminActionLog.updateMany({
    where: {
      OR: [{ marketJobId: { in: marketJobIds } }, { boothJobId: { in: boothJobIds } }],
    },
    data: { marketJobId: null, boothJobId: null },
  });
  // ลำดับตาม FK: ยอดเงิน (cascade payment) → สินค้า → แผง (cascade submission/snapshot) → ตลาด (cascade roster)
  await db.ticketProductFinancial.deleteMany({ where: { product: { ticketId: { in: boothJobIds } } } });
  await db.ticketProduct.deleteMany({ where: { ticketId: { in: boothJobIds } } });
  await db.boothJob.deleteMany({ where: { ticketJobId } });
  await db.marketJob.deleteMany({ where: { ticketJobId } });
  await db.workerAssignmentEvent.deleteMany({ where: { ticketJobId } });
  await db.ticketJobAssignment.deleteMany({ where: { ticketJobId } });
  await db.driverSession.deleteMany({ where: { ticketJobId } });
}

// Function ลบงานรถหลังลบข้อมูลด้านใต้แล้ว (log ของ Admin เหลืออยู่โดยไม่อ้างอิงงานรถ)
export async function deleteTicketJob(
  ticketJobId: number,
  connection?: DbConnection
): Promise<void> {
  const db = client(connection);

  await db.adminActionLog.updateMany({
    where: { ticketJobId },
    data: { ticketJobId: null },
  });
  await db.ticketJob.delete({ where: { id: ticketJobId } });
}
