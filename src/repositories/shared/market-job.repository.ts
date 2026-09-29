// Import Config
import { TERMINAL_TICKET_STATUSES, TICKET_STATUS, VEHICLE_JOB_STATUS } from "../../constants/status";
// Import Mappers
import { mapMarketJob } from "./mappers";
import { client, requireDto } from "./repository-utils";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";
import type { MarketJobDto } from "../../types/worker.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function ค้นหา Business Ticket ที่ยัง active ตาม TicketJob และ TicketNo
export async function findMarketJobByVehicleAndTicketNo(
  ticketJobId: number,
  ticketNo: string,
  connection?: DbConnection
): Promise<MarketJobDto | null> {
  const db = client(connection);
  const marketJob = await db.marketJob.findFirst({
    where: {
      ticketJobId,
      ticketNo,
      status: {
        not: VEHICLE_JOB_STATUS.CANCELLED,
      },
    },
  });

  return mapMarketJob(marketJob);
}

// Function ค้นหา Business Ticket (market job) ตาม id
export async function findMarketJobById(
  id: number,
  connection?: DbConnection
): Promise<MarketJobDto | null> {
  const db = client(connection);
  const marketJob = await db.marketJob.findUnique({
    where: {
      id,
    },
  });

  return mapMarketJob(marketJob);
}

// Function ดึง TicketNo ที่ยัง active ทั้งหมดของ TicketJob
export async function listActiveTicketNosByTicketJobId(
  ticketJobId: number,
  connection?: DbConnection
): Promise<string[]> {
  const db = client(connection);
  const marketJobs = await db.marketJob.findMany({
    where: {
      ticketJobId,
      status: {
        not: VEHICLE_JOB_STATUS.CANCELLED,
      },
    },
    orderBy: {
      id: "asc",
    },
    select: {
      ticketNo: true,
    },
  });

  return marketJobs.map((marketJob) => marketJob.ticketNo);
}

// Function ดึง TicketNo ที่ยัง active ของงานรถพร้อมเวลาสร้าง (ส่งให้ Worker ตอนงานเข้า)
export async function listActiveTicketSummariesByTicketJobId(
  ticketJobId: number,
  connection?: DbConnection
): Promise<Array<{ ticket_no: string; created_at: string }>> {
  const db = client(connection);
  const marketJobs = await db.marketJob.findMany({
    where: {
      ticketJobId,
      status: {
        not: VEHICLE_JOB_STATUS.CANCELLED,
      },
    },
    orderBy: {
      id: "asc",
    },
    select: {
      ticketNo: true,
      createdAt: true,
    },
  });

  return marketJobs.map((marketJob) => ({
    ticket_no: marketJob.ticketNo,
    created_at: marketJob.createdAt.toISOString(),
  }));
}

// Function ยกเลิก Business Ticket พร้อมแผงที่ยังไม่จบ (แผงที่จบแล้วไม่ถูกเขียนทับ)
export async function cancelMarketJobWithCascade(
  marketJobId: number,
  connection?: DbConnection,
): Promise<MarketJobDto> {
  const db = client(connection);
  const marketJob = await db.marketJob.update({
    where: {
      id: marketJobId,
    },
    data: {
      status: VEHICLE_JOB_STATUS.CANCELLED,
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

  return requireDto(mapMarketJob(marketJob), "market job cancel");
}
