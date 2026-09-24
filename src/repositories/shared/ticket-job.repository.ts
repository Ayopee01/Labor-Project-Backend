// Import Library
import { Prisma } from "@prisma/client";

// Import Config
import { TERMINAL_JOB_STATUSES, TERMINAL_TICKET_STATUSES, TICKET_STATUS, VEHICLE_JOB_STATUS } from "../../constants/status";
// Import Repositories
import { countScannedAssignments } from "./ticket-job-assignment.repository";
// Import Mappers
import { mapBoothJob, mapMarketJob, mapTicketProduct, mapTicketJob } from "./mappers";
import { client, requireDto } from "./repository-utils";
// Import Utils
import { resolveTeamReadinessThreshold } from "../../utils/team-requirement";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";
import type { CurrentTicketProgressDto, TicketJobDetailResponse, TicketJobDto, VehicleWorkReadinessDto } from "../../types/worker.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function แปลง vehicle job detail จาก DB — ใช้เฉพาะภายในไฟล์นี้ (helper ของ getTicketJobDetail) จึงไม่ export
function mapTicketJobDetail(
  record: Prisma.TicketJobGetPayload<{
    include: {
      marketJobs: {
        include: {
          tickets: {
            include: {
              products: true;
            };
          };
        };
      };
    };
  }>,
): TicketJobDetailResponse {
  return {
    vehicle_job: requireDto(mapTicketJob(record), "vehicle job"),
    markets: record.marketJobs.map((market) => ({
      ...requireDto(mapMarketJob(market), "market job"),
      booths: market.tickets.map((ticket) => ({
        ...requireDto(mapBoothJob(ticket), "gate ticket"),
        products: ticket.products.map((product) =>
          requireDto(mapTicketProduct(product), "ticket product"),
        ),
      })),
    })),
  };
}

// Function ค้นหา vehicle job ตาม ID จาก DB
export async function findTicketJobById(
  id: number,
  connection?: DbConnection,
): Promise<TicketJobDto | null> {
  const db = client(connection);
  const ticketJob = await db.ticketJob.findUnique({
    where: {
      id,
    },
  });

  return mapTicketJob(ticketJob);
}

// Function ค้นหา vehicle job (TicketNumber) ตาม ref จาก DB
export async function findTicketJobByRef(
  ticketNumber: string,
  connection?: DbConnection,
): Promise<TicketJobDto | null> {
  const db = client(connection);
  const ticketJob = await db.ticketJob.findUnique({
    where: {
      ticketNumber,
    },
  });

  return mapTicketJob(ticketJob);
}

// Function ดึง vehicle job detail จาก DB
export async function getTicketJobDetail(
  id: number,
  connection?: DbConnection,
): Promise<TicketJobDetailResponse | null> {
  const db = client(connection);
  const ticketJob = await db.ticketJob.findUnique({
    where: {
      id,
    },
    include: {
      marketJobs: {
        orderBy: {
          id: "asc",
        },
        include: {
          tickets: {
            orderBy: {
              id: "asc",
            },
            include: {
              products: {
                orderBy: {
                  id: "asc",
                },
              },
            },
          },
        },
      },
    },
  });

  return ticketJob ? mapTicketJobDetail(ticketJob) : null;
}

// Function เริ่มงาน TicketJob: ตั้ง workStartedAt ครั้งแรก (ถ้ายังไม่เคยตั้ง) และเปลี่ยน status เป็น WORKING
export async function markTicketJobInProgress(
  ticketJobId: number,
  connection?: DbConnection,
): Promise<TicketJobDto> {
  const db = client(connection);

  // ตั้ง workStartedAt เฉพาะครั้งแรกที่รถเริ่มทำงานจริง (ไม่ทับถ้าเคยตั้งแล้ว)
  await db.ticketJob.updateMany({
    where: {
      id: ticketJobId,
      workStartedAt: null,
    },
    data: {
      workStartedAt: new Date(),
    },
  });

  const ticketJob = await db.ticketJob.update({
    where: {
      id: ticketJobId,
    },
    data: {
      status: VEHICLE_JOB_STATUS.WORKING,
    },
  });

  return requireDto(mapTicketJob(ticketJob), "vehicle job progress");
}

// Function อัปเดตสถานะของ market job จาก DB
export async function updateMarketJobStatus(
  marketJobId: number,
  status: string,
  connection?: DbConnection,
): Promise<void> {
  const db = client(connection);

  await db.marketJob.update({
    where: {
      id: marketJobId,
    },
    data: {
      status,
    },
  });
}

// Function อัปเดตสถานะของ gate ticket จาก DB
export async function updateBoothJobStatus(
  ticketId: number,
  status: string,
  connection?: DbConnection,
): Promise<CurrentTicketProgressDto["ticket"]> {
  const db = client(connection);
  const ticket = await db.boothJob.update({
    where: {
      id: ticketId,
    },
    data: {
      status,
    },
  });

  return requireDto(mapBoothJob(ticket), "gate ticket status update");
}

// Function หาตั๋วที่ยังไม่ปิด (non-terminal) ใบแรกของ TicketJob พร้อมข้อมูลตลาด
export async function findCurrentOpenTicketByTicketJob(
  ticketJobId: number,
  connection?: DbConnection,
): Promise<CurrentTicketProgressDto | null> {
  const db = client(connection);
  const ticketJob = await db.ticketJob.findUnique({
    where: {
      id: ticketJobId,
    },
    include: {
      marketJobs: {
        orderBy: {
          id: "asc",
        },
        include: {
          tickets: {
            orderBy: {
              id: "asc",
            },
          },
        },
      },
    },
  });

  if (!ticketJob) {
    return null;
  }

  for (const market of ticketJob.marketJobs) {
    const ticket = market.tickets.find(
      (candidate) => !TERMINAL_TICKET_STATUSES.includes(candidate.status),
    );

    if (!ticket) {
      continue;
    }

    return {
      ticket: requireDto(mapBoothJob(ticket), "current gate ticket"),
      marketCode: market.marketCode,
      marketName: market.marketName,
    };
  }

  return null;
}

// Function คำนวณความพร้อมของทีมงาน (จำนวนที่ scan เข้างานแล้วเทียบกับจำนวนที่ต้องการ)
export async function getVehicleWorkReadiness(
  ticketJobId: number,
  connection?: DbConnection,
): Promise<VehicleWorkReadinessDto> {
  const db = client(connection);
  const ticketJob = await db.ticketJob.findUnique({
    where: {
      id: ticketJobId,
    },
    select: {
      workersRequired: true,
      removedAfterScanCount: true,
    },
  });
  const workersRequired = ticketJob?.workersRequired ?? 0;
  // หักจำนวนที่ Admin ถอดออกหลัง Scan แล้ว ทีมที่เหลือจึงส่งยอดได้โดยไม่ต้องรอคนแทน (ดู resolveTeamReadinessThreshold)
  const readinessThreshold = resolveTeamReadinessThreshold(
    workersRequired,
    ticketJob?.removedAfterScanCount,
  );
  const checkedInCount = await countScannedAssignments(
    ticketJobId,
    connection,
  );
  const remainingCount = Math.max(0, readinessThreshold - checkedInCount);

  return {
    workers_required: workersRequired,
    checked_in_count: checkedInCount,
    remaining_count: remainingCount,
    is_ready: readinessThreshold > 0 && checkedInCount >= readinessThreshold,
  };
}

// Function ดึงรายการ vehicle job ที่สถานะ WORKING สำหรับ dispatch worker เพิ่ม
export async function listDispatchableTicketJobs(
  connection?: DbConnection,
): Promise<TicketJobDto[]> {
  const db = client(connection);
  const ticketJobs = await db.ticketJob.findMany({
    where: {
      // status: WORKING เท่านั้น (ไม่รวม RELEASED) — งานที่ release-workers ปล่อยทีมกลับคิวแล้ว
      // จะไม่ถูกดึง worker ใหม่จนกว่า Gate จะเปิด booth ใหม่ หรือ Admin เปิด dispatch คืนเองผ่าน /wait
      status: VEHICLE_JOB_STATUS.WORKING,
    },
    orderBy: {
      id: "asc",
    },
  });

  return ticketJobs
    .map((ticketJob) => mapTicketJob(ticketJob))
    .filter((ticketJob): ticketJob is TicketJobDto => ticketJob !== null);
}

// Function ดึง vehicle job พร้อม market job, ticket และ assignment ทั้งหมด สำหรับใช้ตัดสินใจ lifecycle
export async function findTicketJobLifecycleState(
  ticketJobId: number,
  connection?: DbConnection,
): Promise<Prisma.TicketJobGetPayload<{
  include: {
    marketJobs: {
      include: {
        tickets: true;
      };
    };
    assignments: true;
  };
}> | null> {
  const db = client(connection);

  return db.ticketJob.findUnique({
    where: {
      id: ticketJobId,
    },
    include: {
      marketJobs: {
        include: {
          tickets: true,
        },
      },
      assignments: true,
    },
  });
}

// Function อัปเดตสถานะของ vehicle job จาก DB (ตั้ง completedAt เฉพาะตอนเปลี่ยนเป็น COMPLETED)
export async function updateTicketJobStatus(
  ticketJobId: number,
  status: string,
  connection?: DbConnection,
): Promise<TicketJobDto> {
  const db = client(connection);
  const ticketJob = await db.ticketJob.update({
    where: {
      id: ticketJobId,
    },
    data: {
      status,
      // ตั้ง completedAt เฉพาะตอนเปลี่ยนเป็น COMPLETED เท่านั้น
      ...(status === VEHICLE_JOB_STATUS.COMPLETED && {
        completedAt: new Date(),
      }),
    },
  });

  return requireDto(mapTicketJob(ticketJob), "vehicle job status update");
}

// Function ยกเลิก TicketJob พร้อม cascade MarketJob/BoothJob ที่ยังไม่ terminal ให้เป็น CANCELLED จาก DB
// ยกเว้น MarketJob/BoothJob ที่ terminal ไปแล้ว (COMPLETED/CANCELLED) ไม่ให้ถูกเขียนทับ — ยกเลิกทั้งรถต้องไม่เปลี่ยนประวัติที่จบไปแล้ว
export async function cancelTicketJobWithCascade(
  ticketJobId: number,
  connection?: DbConnection,
): Promise<TicketJobDto> {
  const db = client(connection);
  const ticketJob = await db.ticketJob.update({
    where: {
      id: ticketJobId,
    },
    data: {
      status: VEHICLE_JOB_STATUS.CANCELLED,
      marketJobs: {
        updateMany: {
          where: {
            status: {
              notIn: TERMINAL_JOB_STATUSES,
            },
          },
          data: {
            status: VEHICLE_JOB_STATUS.CANCELLED,
          },
        },
      },
      tickets: {
        updateMany: {
          where: {
            status: {
              notIn: TERMINAL_TICKET_STATUSES,
            },
          },
          data: {
            status: TICKET_STATUS.CANCELLED,
          },
        },
      },
    },
  });

  return requireDto(mapTicketJob(ticketJob), "vehicle job cancel");
}

// Function สลับ dispatchNow และ status ของ TicketJob จากฝั่ง Admin
export async function setTicketJobDispatch(
  ticketJobId: number,
  dispatchNow: boolean,
  status: string,
  connection?: DbConnection,
): Promise<TicketJobDto> {
  const db = client(connection);
  const ticketJob = await db.ticketJob.update({
    where: {
      id: ticketJobId,
    },
    data: {
      dispatchNow,
      status,
      // ปิด dispatch = คืนทั้งทีมเข้าคิวเริ่มใหม่ ล้างจำนวนที่เคยถอดออกหลัง Scan ด้วย เปิด dispatch อีกครั้งจึงได้คนครบตามเดิม
      ...(dispatchNow ? {} : { removedAfterScanCount: 0 }),
    },
  });

  return requireDto(mapTicketJob(ticketJob), "vehicle job dispatch update");
}

// Function นับเพิ่มจำนวน Worker ที่ Admin ถอดออกหลัง Scan แล้ว 1 คน (workers_required คงเดิม ไม่หาคนแทน)
// เขียนแบบมีเงื่อนไขในคำสั่งเดียว ไม่ให้เกิน workers_required — คืน false ถ้านับครบแล้ว
export async function incrementTicketJobRemovedAfterScanCount(
  ticketJobId: number,
  connection?: DbConnection,
): Promise<boolean> {
  const db = client(connection);
  // เทียบสองคอลัมน์ใน WHERE เดียวกัน Prisma updateMany ทำไม่ได้ จึงใช้ raw SQL ให้ยังเป็น atomic update
  const updatedCount = await db.$executeRaw`
    UPDATE ticket_jobs
    SET removed_after_scan_count = removed_after_scan_count + 1,
        updated_at = NOW()
    WHERE id = ${ticketJobId}
      AND removed_after_scan_count < workers_required
  `;

  return updatedCount > 0;
}
