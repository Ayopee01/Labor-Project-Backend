// Import Config
import { VEHICLE_JOB_STATUS } from "../constants/status";
// Import Mappers
import { mapDriverSession, mapTicketJob } from "./shared/mappers";
import { client, createRandomToken, requireDto } from "./shared/repository-utils";
// Import Utils
import { hashRefreshToken } from "../utils/refresh-token-hash";
// Import Types
import type { DbConnection } from "../types/shared/common.type";
import type { ActiveDriverSessionSlotDto, DriverSessionContext, DriverSessionDto } from "../types/driver.type";
import type { TicketJobDto } from "../types/worker.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function ค้นหางานรถจาก driver QR token
export async function findTicketJobByDriverQrToken(
  qrToken: string,
  connection?: DbConnection,
): Promise<TicketJobDto | null> {
  const db = client(connection);
  const ticketJob = await db.ticketJob.findUnique({
    where: {
      driverQrToken: qrToken,
    },
  });

  return mapTicketJob(ticketJob);
}

// Function lock แถวงานรถแล้วอ่านสถานะล่าสุด (เรียกใน transaction เท่านั้น กันนับ active device ทะลุ limit)
export async function lockTicketJobForDriverSession(
  ticketJobId: number,
  connection: DbConnection,
): Promise<TicketJobDto | null> {
  await connection.$queryRaw`SELECT id FROM ticket_jobs WHERE id = ${ticketJobId} FOR UPDATE`;

  const ticketJob = await connection.ticketJob.findUnique({
    where: {
      id: ticketJobId,
    },
  });

  return mapTicketJob(ticketJob);
}

// Function ดึง driver session ที่ยัง active ของงานรถ (คืนแค่ id/device_id สำหรับนับเครื่อง)
export async function listActiveDriverSessionSlots(
  ticketJobId: number,
  connection?: DbConnection,
): Promise<ActiveDriverSessionSlotDto[]> {
  const db = client(connection);
  const sessions = await db.driverSession.findMany({
    where: {
      ticketJobId,
      revokedAt: null,
      expiresAt: {
        gt: new Date(),
      },
    },
    select: {
      id: true,
      deviceId: true,
    },
  });

  return sessions.map((session) => ({
    id: session.id,
    device_id: session.deviceId,
  }));
}

// Function revoke driver session เดียวตอนเครื่องเดิมสแกน QR ซ้ำ (ไม่มี grace period แบบอ่านอย่างเดียว)
export async function revokeDriverSessionById(
  sessionId: number,
  connection?: DbConnection,
): Promise<void> {
  const db = client(connection);

  await db.driverSession.update({
    where: {
      id: sessionId,
    },
    data: {
      revokedAt: new Date(),
    },
  });
}

// Function สร้าง driver session โดยเก็บแค่ hash ของ token และคืน token ดิบครั้งเดียว
export async function createDriverSession(
  ticketJobId: number,
  deviceId: string,
  expiresAt: Date,
  connection?: DbConnection,
): Promise<DriverSessionDto & { session_token: string }> {
  const db = client(connection);
  const rawToken = createRandomToken("driver_session");
  const session = await db.driverSession.create({
    data: {
      ticketJobId,
      deviceId,
      sessionToken: hashRefreshToken(rawToken),
      expiresAt,
    },
  });
  const mapped = requireDto(mapDriverSession(session), "driver session create");

  return {
    ...mapped,
    session_token: rawToken,
  };
}

// Function ค้นหา driver session ที่ยังใช้ได้จาก token (รวม session อ่านอย่างเดียวช่วง grace period)
export async function findUsableDriverSessionByToken(
  sessionToken: string,
  connection?: DbConnection,
): Promise<DriverSessionContext | null> {
  const db = client(connection);
  const now = new Date();
  const session = await db.driverSession.findFirst({
    where: {
      sessionToken: hashRefreshToken(sessionToken),
      OR: [
        {
          revokedAt: null,
          expiresAt: {
            gt: now,
          },
        },
        {
          revokedAt: {
            not: null,
          },
          readOnlyUntil: {
            gt: now,
          },
        },
      ],
    },
  });

  if (!session) {
    return null;
  }

  const mapped = requireDto(mapDriverSession(session), "driver session lookup");

  return {
    ...mapped,
    is_read_only: session.revokedAt !== null,
  };
}

// Function อัปเดตงานรถเป็นพร้อมทำงานเมื่อ Driver กด Ready
export async function markTicketJobReady(
  ticketJobId: number,
  connection?: DbConnection,
): Promise<TicketJobDto> {
  const db = client(connection);
  const ticketJob = await db.ticketJob.update({
    where: {
      id: ticketJobId,
    },
    data: {
      status: VEHICLE_JOB_STATUS.WORKING,
      // Driver กด Ready เท่ากับเปิด dispatch เสมอ
      dispatchNow: true,
      marketJobs: {
        updateMany: {
          where: {
            status: {
              in: [VEHICLE_JOB_STATUS.WAIT, VEHICLE_JOB_STATUS.WORKING],
            },
          },
          data: {
            status: VEHICLE_JOB_STATUS.WORKING,
          },
        },
      },
    },
  });

  return requireDto(mapTicketJob(ticketJob), "vehicle job ready");
}

// Function ดึงข้อมูลงานรถสำหรับ Driver (ไม่ join ข้อมูล worker เพื่อกันข้อมูลส่วนตัวหลุด)
export async function getDriverJobSnapshotRecord(
  ticketJobId: number,
  connection?: DbConnection,
) {
  const db = client(connection);

  return db.ticketJob.findUnique({
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
      assignments: {
        select: {
          status: true,
        },
      },
    },
  });
}
