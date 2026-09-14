// Import Config
import { VEHICLE_JOB_STATUS } from "../constants/status";
// Import Mappers
import { mapDriverSession, mapTicketJob } from "./shared/mappers";
import { client, createRandomToken, requireDto } from "./shared/repository-utils";
// Import Utils
import { hashRefreshToken } from "../utils/refresh-token-hash";
// Import Types
import type { DbConnection } from "../types/shared/common.type";
import type { DriverSessionDto } from "../types/driver.type";
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

// Function สร้าง driver session จาก DB — เก็บเฉพาะ Hash ของ Token ลงคอลัมน์ sessionToken เท่านั้น ไม่เก็บ
// Token ดิบเลย กันหลุดตรงๆ ถ้า DB รั่ว โดยคืน Token ดิบให้ Caller ครั้งเดียวตอนสร้างเท่านั้น (เหมือน Refresh Token)
export async function createDriverSession(
  ticketJobId: number,
  expiresAt: Date,
  connection?: DbConnection,
): Promise<DriverSessionDto> {
  const db = client(connection);
  const rawToken = createRandomToken("driver_session");
  const session = await db.driverSession.create({
    data: {
      ticketJobId,
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

// Function ค้นหา active driver session ตาม token จาก DB — เทียบด้วย Hash เสมอ (Token ดิบไม่เคยถูกเก็บลง DB)
export async function findActiveDriverSessionByToken(
  sessionToken: string,
  connection?: DbConnection,
): Promise<DriverSessionDto | null> {
  const db = client(connection);
  const session = await db.driverSession.findFirst({
    where: {
      sessionToken: hashRefreshToken(sessionToken),
      revokedAt: null,
      expiresAt: {
        gt: new Date(),
      },
    },
  });

  return mapDriverSession(session);
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
