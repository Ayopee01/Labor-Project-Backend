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

// Function ค้นหา vehicle job ตาม driver QR token จาก DB
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

// Function lock แถว vehicle job (FOR UPDATE) แล้วอ่านสถานะล่าสุด ต้องเรียกใน transaction เท่านั้น —
// กันหลายเครื่องสแกน QR เดียวกันพร้อมกันแล้วนับ active device ทะลุ limit (ดู 38.5 ข้อ 7)
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

// Function ดึง active driver session (ยังไม่ revoke และยังไม่หมดอายุ) ทั้งหมดของ vehicle job นี้ — ใช้
// ตัดสิน active device count/rotate เท่านั้น จึงคืนแค่ id/device_id ไม่คืน session token
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

// Function revoke driver session เดียวจาก DB — ใช้ตอน device เดิมสแกน QR ซ้ำ (rotate) เท่านั้น ไม่ตั้ง
// readOnlyUntil เพราะไม่ใช่ terminal event จึงไม่ได้สิทธิ์อ่านต่อแบบ grace (ต่างจาก revokeDriverSessionsByTicketJobId)
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

// Function สร้าง driver session จาก DB — เก็บเฉพาะ Hash ของ Token ลงคอลัมน์ sessionToken เท่านั้น ไม่เก็บ
// Token ดิบเลย กันหลุดตรงๆ ถ้า DB รั่ว โดยคืน Token ดิบให้ Caller ครั้งเดียวตอนสร้างเท่านั้น (เหมือน Refresh Token)
export async function createDriverSession(
  ticketJobId: number,
  deviceId: string | null,
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

// Function ค้นหา driver session ที่ยังใช้งานได้จาก token — คืนทั้ง session ที่ active ปกติ และ session ที่
// ถูก revoke เพราะรถเข้า terminal แต่ยังอยู่ใน grace period (readOnlyUntil ยังไม่ผ่าน) โดยแนบ is_read_only
// ให้ caller ตัดสินว่า mutate ได้หรือไม่ — เทียบด้วย Hash เสมอ (Token ดิบไม่เคยถูกเก็บลง DB)
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

// Function อัปเดตสถานะ vehicle job ready จาก DB
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
      // Driver กด Ready เทียบเท่า Dispatch:true เสมอ ต้อง sync dispatchNow ให้ตรงสถานะจริง ไม่งั้น
      // Operations board จะค้างแสดง wait_unload ทั้งที่ทีมกำลังทำงานจริงแล้ว
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

// Function ดึง vehicle job snapshot สำหรับ Driver — รวม assignment status (ใช้คำนวณ OperationStatus
// เท่านั้น) โดยไม่ join ข้อมูล worker ใดๆ กันข้อมูลส่วนตัว/ของ Admin หลุดไปที่ Driver payload
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
