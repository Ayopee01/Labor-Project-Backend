// Import Config
import { ACCEPTED_ASSIGNMENT_STATUSES, ACTIVE_ASSIGNMENT_STATUSES, ASSIGNMENT_STATUS, FINISHED_ASSIGNMENT_STATUSES, RELEASABLE_ASSIGNMENT_STATUSES, SCANNED_ASSIGNMENT_STATUSES, TICKET_STATUS, TICKET_WORKER_STATUS, WORKING_ASSIGNMENT_STATUSES } from "../../constants/status";
import { withTransaction } from "../../db/prisma";
import { WORKER_ASSIGNMENT_EVENT_TYPE } from "../../types/shared/worker-assignment-event.type";
// Import Repositories
import * as workerAssignmentEventRepository from "./worker-assignment-event.repository";
// Import Mappers
import { mapTicketJobAssignment } from "./mappers";
import { client, requireDto } from "./repository-utils";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";
import type { WorkerAssignmentEventType } from "../../types/shared/worker-assignment-event.type";
import type { TicketJobAssignmentDto, VehicleWorkReadinessDto, WorkerAssignmentTeamRawMemberDto } from "../../types/worker.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function นับ active assignments จาก DB
export async function countActiveAssignments(
  ticketJobId: number,
  connection?: DbConnection
): Promise<number> {
  const db = client(connection);
  return db.ticketJobAssignment.count({
    where: {
      ticketJobId,
      status: {
        in: ACTIVE_ASSIGNMENT_STATUSES,
      },
    },
  });
}

// Type รายการ assignment ที่เลย deadline มาแล้วแต่ยังไม่ถูกเปลี่ยนเป็น TIMEOUT — ใช้โดย assignment-timeout-sweep
export type OverdueAssignmentDto = {
  id: number;
  worker_id: number;
  kind: "accept" | "scan";
};

// Function หา assignment ที่เลย accept/scan deadline มาแล้ว graceMs แต่สถานะยังไม่ถูกเปลี่ยนเป็น TIMEOUT
// (เผื่อกรณี BullMQ timeout job ของ assignment นั้นพังไปหมด retry แล้วไม่มีอะไรมาประมวลผลซ้ำ) — เป็นตาข่าย
// สำรอง ไม่ใช่ทางหลัก จึงเว้น graceMs ให้ BullMQ job ปกติมีเวลาทำงานก่อนเสมอ กันแย่งประมวลผลซ้ำกันเปล่าๆ
export async function listOverdueAssignments(
  graceMs: number,
  connection?: DbConnection
): Promise<OverdueAssignmentDto[]> {
  const db = client(connection);
  const cutoff = new Date(Date.now() - graceMs);

  const [overdueAccepts, overdueScans] = await Promise.all([
    db.ticketJobAssignment.findMany({
      where: {
        status: ASSIGNMENT_STATUS.PENDING,
        acceptDeadlineAt: { lte: cutoff },
      },
      select: { id: true, workerId: true },
    }),
    db.ticketJobAssignment.findMany({
      where: {
        status: ASSIGNMENT_STATUS.ACCEPTED,
        scanDeadlineAt: { lte: cutoff },
      },
      select: { id: true, workerId: true },
    }),
  ]);

  return [
    ...overdueAccepts.map((assignment) => ({
      id: assignment.id,
      worker_id: assignment.workerId,
      kind: "accept" as const,
    })),
    ...overdueScans.map((assignment) => ({
      id: assignment.id,
      worker_id: assignment.workerId,
      kind: "scan" as const,
    })),
  ];
}

// Function นับจำนวนงานของ worker ในวันที่ระบุ (ไม่นับ TIMEOUT) และจำนวนที่ทำเสร็จแล้ว
export async function getWorkerDailyAssignmentCounts(
  workerId: number,
  startAt: Date,
  endAt: Date,
  connection?: DbConnection,
): Promise<{
  today_job_count: number;
  completed_job_count: number;
}> {
  const db = client(connection);
  const [todayJobCount, completedJobCount] = await Promise.all([
    db.ticketJobAssignment.count({
      where: {
        workerId,
        createdAt: {
          gte: startAt,
          lt: endAt,
        },
        status: {
          not: ASSIGNMENT_STATUS.TIMEOUT,
        },
      },
    }),
    db.ticketJobAssignment.count({
      where: {
        workerId,
        createdAt: {
          gte: startAt,
          lt: endAt,
        },
        OR: [
          {
            status: ASSIGNMENT_STATUS.COMPLETED,
          },
          {
            completedAt: {
              not: null,
            },
          },
        ],
      },
    }),
  ]);

  return {
    today_job_count: todayJobCount,
    completed_job_count: completedJobCount,
  };
}

// Function สร้าง assignment จาก DB
export async function createAssignment(
  ticketJobId: number,
  workerId: number,
  acceptDeadlineAt: Date,
  connection?: DbConnection
): Promise<TicketJobAssignmentDto> {
  if (!connection) {
    return withTransaction((transaction) =>
      createAssignment(ticketJobId, workerId, acceptDeadlineAt, transaction)
    );
  }

  const db = client(connection);
  const assignment = await db.ticketJobAssignment.create({
    data: {
      ticketJobId,
      workerId,
      status: ASSIGNMENT_STATUS.PENDING,
      acceptDeadlineAt,
    },
  });
  await workerAssignmentEventRepository.createOnce(
    {
      assignment_id: assignment.id,
      worker_id: assignment.workerId,
      vehicle_job_id: assignment.ticketJobId,
      event_type: WORKER_ASSIGNMENT_EVENT_TYPE.ASSIGNED,
      occurred_at: assignment.createdAt,
    },
    connection
  );

  return requireDto(mapTicketJobAssignment(assignment), "assignment create");
}

// Function ค้นหา current assignment ตาม worker จาก DB
export async function findCurrentAssignmentByWorker(
  workerId: number,
  connection?: DbConnection
): Promise<TicketJobAssignmentDto | null> {
  const db = client(connection);
  const assignment = await db.ticketJobAssignment.findFirst({
    where: {
      workerId,
      status: {
        in: ACTIVE_ASSIGNMENT_STATUSES,
      },
    },
    orderBy: {
      id: "desc",
    },
  });

  return mapTicketJobAssignment(assignment);
}

// Function ค้นหา assignment ตาม ID จาก DB
export async function findAssignmentById(
  assignmentId: number,
  connection?: DbConnection
): Promise<TicketJobAssignmentDto | null> {
  const db = client(connection);
  const assignment = await db.ticketJobAssignment.findUnique({
    where: {
      id: assignmentId,
    },
  });

  return mapTicketJobAssignment(assignment);
}

// Function นับ scanned assignments จาก DB
export async function countScannedAssignments(
  ticketJobId: number,
  connection?: DbConnection
): Promise<number> {
  const db = client(connection);
  return db.ticketJobAssignment.count({
    where: {
      ticketJobId,
      status: {
        in: SCANNED_ASSIGNMENT_STATUSES,
      },
    },
  });
}

// Function นับ assignment ที่ worker กด Accept งานแล้ว (ไม่ว่าจะ scan ต่อหรือยัง)
export async function countAcceptedAssignments(
  ticketJobId: number,
  connection?: DbConnection
): Promise<number> {
  const db = client(connection);
  return db.ticketJobAssignment.count({
    where: {
      ticketJobId,
      status: {
        in: ACCEPTED_ASSIGNMENT_STATUSES,
      },
    },
  });
}

// Function ตรวจความพร้อมของทีมงาน (scan ครบตามจำนวนที่ต้องการหรือยัง) ของ TicketJob
export async function getTicketJobTeamScanReadiness(
  ticketJobId: number,
  connection?: DbConnection,
): Promise<VehicleWorkReadinessDto> {
  const db = client(connection);
  // เทียบกับ workersRequired ไม่ใช่จำนวน assignment ที่สร้างจริง กันเข้าใจผิดว่าทีมพร้อมทั้งที่ dispatch ยังหา worker ไม่ครบ
  const [ticketJob, checkedInCount] = await Promise.all([
    db.ticketJob.findUnique({
      where: {
        id: ticketJobId,
      },
      select: {
        workersRequired: true,
      },
    }),
    db.ticketJobAssignment.count({
      where: {
        ticketJobId,
        status: {
          in: SCANNED_ASSIGNMENT_STATUSES,
        },
      },
    }),
  ]);
  const workersRequired = ticketJob?.workersRequired ?? 0;
  const remainingCount = Math.max(0, workersRequired - checkedInCount);

  return {
    workers_required: workersRequired,
    checked_in_count: checkedInCount,
    remaining_count: remainingCount,
    is_ready: workersRequired > 0 && checkedInCount >= workersRequired,
  };
}

// Function ดึงทีม assignment ของ TicketJob จาก DB ดิบๆ ไม่คำนวณ scan_status ที่นี่ (ดู buildAssignmentScanStatus ใน worker.service.ts)
export async function listTicketJobAssignmentTeam(
  ticketJobId: number,
  connection?: DbConnection
): Promise<WorkerAssignmentTeamRawMemberDto[]> {
  const db = client(connection);
  const assignments = await db.ticketJobAssignment.findMany({
    where: {
      ticketJobId,
      status: {
        in: FINISHED_ASSIGNMENT_STATUSES,
      },
    },
    orderBy: {
      id: "asc",
    },
    include: {
      worker: true,
    },
  });

  return assignments.map((assignment) => {
    const assignmentDto = requireDto(
      mapTicketJobAssignment(assignment),
      "vehicle job assignment"
    );

    return {
      worker_id: assignment.workerId,
      full_name: assignment.worker.fullName ?? assignment.worker.name ?? assignment.worker.laborCode,
      worker_code: assignment.worker.laborCode,
      coat_no: assignment.worker.coatNo ?? null,
      image_url: assignment.worker.imageUrl,
      status: assignmentDto.status,
      completed_at: assignmentDto.completed_at,
      accepted_at: assignmentDto.accepted_at,
      scanned_at: assignmentDto.scanned_at,
    };
  });
}

// Function ค้นหา current assignment ของ worker ใน TicketJob ตาม TicketNumber จาก DB
export async function findCurrentAssignmentByTicketJobRefAndWorker(
  ticketNumber: string,
  workerId: number,
  connection?: DbConnection
): Promise<TicketJobAssignmentDto | null> {
  const db = client(connection);
  const assignment = await db.ticketJobAssignment.findFirst({
    where: {
      workerId,
      status: {
        in: ACTIVE_ASSIGNMENT_STATUSES,
      },
      ticketJob: {
        ticketNumber,
      },
    },
    orderBy: {
      id: "desc",
    },
  });

  return mapTicketJobAssignment(assignment);
}

// Function หา assignment ปัจจุบันของ worker ด้วย ticketJobId ตรงๆ (ไม่ผ่าน ticketNumber) ใช้ตอน resolve TicketCompletionSubmission.assignmentId
export async function findCurrentAssignmentByTicketJobIdAndWorker(
  ticketJobId: number,
  workerId: number,
  connection?: DbConnection
): Promise<TicketJobAssignmentDto | null> {
  const db = client(connection);
  const assignment = await db.ticketJobAssignment.findFirst({
    where: {
      ticketJobId,
      workerId,
      status: {
        in: ACTIVE_ASSIGNMENT_STATUSES,
      },
    },
    orderBy: {
      id: "desc",
    },
  });

  return mapTicketJobAssignment(assignment);
}

// Function เปลี่ยน assignment เป็น ACCEPTED แบบกัน race
export async function acceptAssignment(
  assignmentId: number,
  scanDeadlineAt: Date,
  connection?: DbConnection
): Promise<TicketJobAssignmentDto | null> {
  if (!connection) {
    return withTransaction((transaction) =>
      acceptAssignment(assignmentId, scanDeadlineAt, transaction)
    );
  }

  const db = client(connection);
  const acceptedAt = new Date();
  const updateResult = await db.ticketJobAssignment.updateMany({
    where: {
      id: assignmentId,
      status: ASSIGNMENT_STATUS.PENDING,
    },
    data: {
      status: ASSIGNMENT_STATUS.ACCEPTED,
      acceptedAt,
      scanDeadlineAt,
    },
  });

  if (updateResult.count === 0) {
    return null;
  }

  const assignment = await db.ticketJobAssignment.findUniqueOrThrow({
    where: {
      id: assignmentId,
    },
  });
  await workerAssignmentEventRepository.createOnce(
    {
      assignment_id: assignment.id,
      worker_id: assignment.workerId,
      vehicle_job_id: assignment.ticketJobId,
      event_type: WORKER_ASSIGNMENT_EVENT_TYPE.ACCEPTED,
      occurred_at: acceptedAt,
    },
    connection
  );

  return requireDto(mapTicketJobAssignment(assignment), "assignment accept");
}

// Function ดึงรายการ assignment ที่สถานะเป็น ACCEPTED ของ TicketJob นี้ — filters.excludedAssignmentId ใช้ตอน
// ต่อเวลาทีมที่เหลือ (ยกเว้นคนที่เพิ่ง scan เข้ามาเอง) ส่วน filters.workerCodes ใช้ตอน Admin เจาะจงต่อเวลาบางคน
export async function listAcceptedAssignmentsByTicketJob(
  ticketJobId: number,
  filters?: { excludedAssignmentId?: number; workerCodes?: string[] },
  connection?: DbConnection
): Promise<TicketJobAssignmentDto[]> {
  const db = client(connection);
  const workerCodes = filters?.workerCodes;
  const workerIds =
    workerCodes && workerCodes.length > 0
      ? (
          await db.masterWorker.findMany({
            where: {
              laborCode: {
                in: workerCodes,
              },
            },
            select: {
              id: true,
            },
          })
        ).map((worker) => worker.id)
      : undefined;

  if (workerCodes && workerCodes.length > 0 && workerIds?.length === 0) {
    return [];
  }

  const assignments = await db.ticketJobAssignment.findMany({
    where: {
      ticketJobId,
      status: ASSIGNMENT_STATUS.ACCEPTED,
      ...(workerIds &&
        workerIds.length > 0 && {
          workerId: {
            in: workerIds,
          },
        }),
      ...(filters?.excludedAssignmentId
        ? {
          id: {
            not: filters.excludedAssignmentId,
          },
        }
        : {}),
    },
    orderBy: {
      id: "asc",
    },
  });

  return assignments
    .map((assignment) => mapTicketJobAssignment(assignment))
    .filter((assignment): assignment is TicketJobAssignmentDto => assignment !== null);
}

// Function ดึงรายการ active assignments ตาม vehicle job จาก DB
export async function listActiveAssignmentsByTicketJob(
  ticketJobId: number,
  connection?: DbConnection,
): Promise<TicketJobAssignmentDto[]> {
  const db = client(connection);
  const assignments = await db.ticketJobAssignment.findMany({
    where: {
      ticketJobId,
      status: {
        in: ACTIVE_ASSIGNMENT_STATUSES,
      },
    },
    orderBy: {
      id: "asc",
    },
  });

  return assignments
    .map((assignment) => mapTicketJobAssignment(assignment))
    .filter(
      (assignment): assignment is TicketJobAssignmentDto =>
        assignment !== null,
    );
}

// Function ยกเลิก assignment ที่ยัง active ทั้งหมดของ TicketJob พร้อมบันทึก WorkerAssignmentEvent — ไม่แตะ
// TicketWorker/MarketJob/BoothJob/TicketJob เอง (ต่างจาก cancelAssignment ที่ถอด Worker ออกจาก Booth ด้วย)
// source แยกความหมาย metadata ตาม flow ที่เรียก (เช่น ยกเลิกทั้งคัน vs กลับไป Wait ก่อนทีมเริ่มทำงานจริง)
export async function cancelActiveAssignmentsForTicketJob(
  ticketJobId: number,
  source: string,
  connection?: DbConnection,
): Promise<TicketJobAssignmentDto[]> {
  if (!connection) {
    return withTransaction((transaction) =>
      cancelActiveAssignmentsForTicketJob(ticketJobId, source, transaction),
    );
  }

  const db = client(connection);
  const activeAssignments = await db.ticketJobAssignment.findMany({
    where: {
      ticketJobId,
      status: {
        in: ACTIVE_ASSIGNMENT_STATUSES,
      },
    },
    orderBy: {
      id: "asc",
    },
  });

  if (activeAssignments.length === 0) {
    return [];
  }

  await db.ticketJobAssignment.updateMany({
    where: {
      ticketJobId,
      status: {
        in: ACTIVE_ASSIGNMENT_STATUSES,
      },
    },
    data: {
      status: ASSIGNMENT_STATUS.CANCELLED,
    },
  });

  const now = new Date();

  await workerAssignmentEventRepository.createManyOnce(
    activeAssignments.map((assignment) => ({
      assignment_id: assignment.id,
      worker_id: assignment.workerId,
      vehicle_job_id: assignment.ticketJobId,
      event_type: WORKER_ASSIGNMENT_EVENT_TYPE.ADMIN_CANCELLED,
      occurred_at: now,
      metadata: {
        source,
      },
    })),
    connection,
  );

  return activeAssignments
    .map(mapTicketJobAssignment)
    .filter((assignment): assignment is TicketJobAssignmentDto => assignment !== null);
}

// Function ยกเลิก assignment จาก DB พร้อมถอด Worker ออกจาก Booth ที่ยังไม่ Complete — เขียนแบบมีเงื่อนไข (status ต้องยังอยู่ใน ACTIVE_ASSIGNMENT_STATUSES ณ ตอนเขียนจริง)
// กัน TOCTOU race กับ worker ที่กำลัง accept/scan/timeout พร้อมกัน — คืน null เมื่อแพ้ race
export async function cancelAssignment(
  assignmentId: number,
  connection?: DbConnection,
): Promise<TicketJobAssignmentDto | null> {
  if (!connection) {
    return withTransaction((transaction) =>
      cancelAssignment(assignmentId, transaction),
    );
  }

  const db = client(connection);
  const now = new Date();

  const updateResult = await db.ticketJobAssignment.updateMany({
    where: {
      id: assignmentId,
      status: {
        in: ACTIVE_ASSIGNMENT_STATUSES,
      },
    },
    data: {
      status: ASSIGNMENT_STATUS.CANCELLED,
    },
  });

  if (updateResult.count === 0) {
    return null;
  }

  const assignment = await db.ticketJobAssignment.findUniqueOrThrow({
    where: {
      id: assignmentId,
    },
  });
  await workerAssignmentEventRepository.createOnce(
    {
      assignment_id: assignment.id,
      worker_id: assignment.workerId,
      vehicle_job_id: assignment.ticketJobId,
      event_type: WORKER_ASSIGNMENT_EVENT_TYPE.ADMIN_CANCELLED,
      occurred_at: now,
      metadata: {
        source: "admin_assignment_cancel",
      },
    },
    connection,
  );

  // ถอด Worker ออกจาก Roster ของทุก Business Ticket ที่ยังไม่ Terminal ภายใต้ TicketNumber เดียวกัน (Ticket ที่ Lock/Terminal แล้วต้องไม่ถูกแก้ Roster ย้อนหลัง)
  await db.ticketWorker.updateMany({
    where: {
      workerId: assignment.workerId,

      status: TICKET_WORKER_STATUS.WORKING,

      marketJob: {
        ticketJobId: assignment.ticketJobId,

        status: {
          notIn: [TICKET_STATUS.COMPLETED, TICKET_STATUS.CANCELLED],
        },
      },
    },

    data: {
      status: TICKET_WORKER_STATUS.CANCELLED,
      cancelledAt: now,
      completedAt: null,
    },
  });

  return requireDto(mapTicketJobAssignment(assignment), "assignment cancel");
}

// Function ต่อเวลา assignment scan deadline จาก DB — เขียนแบบมีเงื่อนไข (status ต้องยังเป็น ACCEPTED ณ ตอนเขียนจริง)
// กัน TOCTOU race กับ scan-timeout job หรือ worker ที่ scan สำเร็จพร้อมกัน — คืน null เมื่อแพ้ race
export async function extendAssignmentScanDeadline(
  assignmentId: number,
  scanDeadlineAt: Date,
  connection?: DbConnection,
): Promise<TicketJobAssignmentDto | null> {
  const db = client(connection);
  const updateResult = await db.ticketJobAssignment.updateMany({
    where: {
      id: assignmentId,
      status: ASSIGNMENT_STATUS.ACCEPTED,
    },
    data: {
      scanDeadlineAt,
    },
  });

  if (updateResult.count === 0) {
    return null;
  }

  const assignment = await db.ticketJobAssignment.findUniqueOrThrow({
    where: {
      id: assignmentId,
    },
  });

  return requireDto(
    mapTicketJobAssignment(assignment),
    "assignment extend scan",
  );
}

// Function อัปเดต scan deadline ของ assignment
export async function updateAssignmentScanDeadline(
  assignmentId: number,
  scanDeadlineAt: Date,
  connection?: DbConnection
): Promise<TicketJobAssignmentDto> {
  const db = client(connection);
  const assignment = await db.ticketJobAssignment.update({
    where: {
      id: assignmentId,
    },
    data: {
      scanDeadlineAt,
    },
  });

  return requireDto(mapTicketJobAssignment(assignment), "assignment scan deadline");
}

// Function เปลี่ยน assignment เป็น TIMEOUT แบบกัน race
export async function timeoutAssignment(
  assignmentId: number,
  eventType: Extract<
    WorkerAssignmentEventType,
    "ACCEPT_TIMEOUT" | "SCAN_TIMEOUT"
  >,
  connection?: DbConnection
): Promise<TicketJobAssignmentDto | null> {
  if (!connection) {
    return withTransaction((transaction) =>
      timeoutAssignment(assignmentId, eventType, transaction)
    );
  }

  const db = client(connection);
  const occurredAt = new Date();
  const expectedStatus =
    eventType === WORKER_ASSIGNMENT_EVENT_TYPE.ACCEPT_TIMEOUT
      ? ASSIGNMENT_STATUS.PENDING
      : ASSIGNMENT_STATUS.ACCEPTED;
  const updateResult = await db.ticketJobAssignment.updateMany({
    where: {
      id: assignmentId,
      status: expectedStatus,
    },
    data: {
      status: ASSIGNMENT_STATUS.TIMEOUT,
    },
  });

  if (updateResult.count === 0) {
    return null;
  }

  const assignment = await db.ticketJobAssignment.findUniqueOrThrow({
    where: {
      id: assignmentId,
    },
  });
  await workerAssignmentEventRepository.createOnce(
    {
      assignment_id: assignment.id,
      worker_id: assignment.workerId,
      vehicle_job_id: assignment.ticketJobId,
      event_type: eventType,
      occurred_at: occurredAt,
    },
    connection
  );

  return requireDto(mapTicketJobAssignment(assignment), "assignment timeout");
}

// Function เปลี่ยน assignment เป็น SCANNED แบบมีเงื่อนไข (ต้องเป็น ACCEPTED อยู่ก่อน) กัน race กับ scan-timeout job ที่อาจแย่งเปลี่ยนสถานะเดียวกัน คืน null ถ้าแพ้ race
export async function scanAssignment(
  assignmentId: number,
  metadata?: Record<string, unknown> | null,
  connection?: DbConnection,
): Promise<TicketJobAssignmentDto | null> {
  if (!connection) {
    return withTransaction((transaction) => scanAssignment(assignmentId, metadata, transaction));
  }

  const db = client(connection);
  const scannedAt = new Date();
  const updateResult = await db.ticketJobAssignment.updateMany({
    where: {
      id: assignmentId,
      status: ASSIGNMENT_STATUS.ACCEPTED,
    },
    data: {
      status: ASSIGNMENT_STATUS.SCANNED,
      scannedAt,
    },
  });

  if (updateResult.count === 0) {
    return null;
  }

  const assignment = await db.ticketJobAssignment.findUniqueOrThrow({
    where: {
      id: assignmentId,
    },
  });
  await workerAssignmentEventRepository.createOnce(
    {
      assignment_id: assignment.id,
      worker_id: assignment.workerId,
      vehicle_job_id: assignment.ticketJobId,
      event_type: WORKER_ASSIGNMENT_EVENT_TYPE.SCANNED,
      occurred_at: scannedAt,
      metadata: metadata ?? null,
    },
    connection
  );

  return requireDto(mapTicketJobAssignment(assignment), "assignment scan");
}

// Function เปลี่ยนสถานะ assignment ทุกใบของรถที่ยัง WORKING_ASSIGNMENT_STATUSES ให้เป็น toStatus เดียวกัน ใช้ตอน Vendor confirm/reject ซึ่งกระทบทั้งทีม
export async function setVehicleAssignmentsStatus(
  ticketJobId: number,
  toStatus: (typeof ASSIGNMENT_STATUS)[keyof typeof ASSIGNMENT_STATUS],
  connection?: DbConnection
): Promise<number> {
  const db = client(connection);
  const result = await db.ticketJobAssignment.updateMany({
    where: {
      ticketJobId,
      status: {
        in: WORKING_ASSIGNMENT_STATUSES,
      },
    },
    data: {
      status: toStatus,
    },
  });

  return result.count;
}

// Function เปลี่ยนสถานะ assignment หลายใบเป็น COMPLETED พร้อมกัน
export async function completeAssignments(
  assignmentIds: number[],
  completedAt: Date,
  connection?: DbConnection,
): Promise<number> {
  if (assignmentIds.length === 0) {
    return 0;
  }

  const db = client(connection);
  const result = await db.ticketJobAssignment.updateMany({
    where: {
      id: {
        in: assignmentIds,
      },
    },
    data: {
      status: ASSIGNMENT_STATUS.COMPLETED,
      completedAt,
    },
  });

  return result.count;
}

// Function ค้นหา assignment ของ TicketJob ที่ Admin ปล่อยกลับคิวก่อนเวลาได้จาก DB
export async function listReleasableAssignmentsByTicketJob(
  ticketJobId: number,
  connection?: DbConnection,
): Promise<TicketJobAssignmentDto[]> {
  const db = client(connection);
  const assignments = await db.ticketJobAssignment.findMany({
    where: {
      ticketJobId,
      status: {
        in: RELEASABLE_ASSIGNMENT_STATUSES,
      },
    },
    orderBy: {
      id: "asc",
    },
  });

  return assignments
    .map((assignment) => mapTicketJobAssignment(assignment))
    .filter((assignment): assignment is TicketJobAssignmentDto => assignment !== null);
}

// Function ปล่อย assignment กลับคิวก่อนเวลาโดย Admin ใน DB (ไม่รอทั้ง TicketNumber จบ)
export async function releaseAssignments(
  assignmentIds: number[],
  releasedAt: Date,
  connection?: DbConnection,
): Promise<number> {
  if (assignmentIds.length === 0) {
    return 0;
  }

  const db = client(connection);
  const result = await db.ticketJobAssignment.updateMany({
    where: {
      id: {
        in: assignmentIds,
      },
      status: {
        in: RELEASABLE_ASSIGNMENT_STATUSES,
      },
    },
    data: {
      status: ASSIGNMENT_STATUS.RELEASED,
      releasedAt,
    },
  });

  return result.count;
}
