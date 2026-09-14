// Import Library
import type { Prisma } from "@prisma/client";
// Import Mappers
import { mapWorkerSession } from "./mappers";
import { buildRevokeData, client, requireMapped, toId } from "./repository-utils";
// Import Types
import type { SessionDto } from "../../types/auth.type";
import type { DbConnection } from "../../types/shared/common.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function สร้าง active session where จาก DB
function buildActiveSessionWhere(
  where: Prisma.UserSessionWhereInput = {}
): Prisma.UserSessionWhereInput {
  return {
    ...where,
    isActive: true,
    expiresAt: {
      gt: new Date(),
    },
  };
}

// Function ค้นหา active ตาม worker ID จาก DB
export async function findActiveByWorkerId(
  workerId: number | string,
  connection?: DbConnection
): Promise<SessionDto | null> {
  return mapWorkerSession(
    await client(connection).userSession.findFirst({
      where: buildActiveSessionWhere({
        role: "worker",
        workerId: toId(workerId),
      }),
      orderBy: {
        id: "desc",
      },
    })
  );
}

// Function ค้นหา active ตาม ID จาก DB
export async function findActiveById(
  sessionId: number | string,
  connection?: DbConnection
): Promise<SessionDto | null> {
  return mapWorkerSession(
    await client(connection).userSession.findFirst({
      where: {
        id: toId(sessionId),
        role: "worker",
        isActive: true,
        expiresAt: {
          gt: new Date(),
        },
      },
    })
  );
}

// Function สร้าง pending session (ยังไม่มี refresh token hash จริง) จาก DB
export async function createPending(
  session: {
    account_id: number;
    device_id: string;
    device_name: string;
    ip_address?: string | null;
    user_agent?: string | null;
    expires_at: string | Date;
  },
  connection?: DbConnection
): Promise<SessionDto> {
  return requireMapped(
    mapWorkerSession(
      await client(connection).userSession.create({
        data: {
          role: "worker",
          workerId: session.account_id,
          refreshTokenHash: "",
          deviceId: session.device_id,
          deviceName: session.device_name,
          ipAddress: session.ip_address ?? null,
          userAgent: session.user_agent ?? null,
          expiresAt: new Date(session.expires_at),
        },
      })
    ),
    "WorkerSession",
    "create"
  );
}

// Function อัปเดต refresh token hash จาก DB — เขียนแบบมีเงื่อนไข กัน TOCTOU race เดียวกับ
// sessionRepository.updateRefreshTokenHash ฝั่ง Admin (ดู repositories/auth.repository.ts)
export async function updateRefreshTokenHash(
  sessionId: number | string,
  refreshTokenHash: string,
  expectedCurrentHash: string,
  connection?: DbConnection
): Promise<SessionDto | null> {
  const db = client(connection);
  const updatedAt = new Date();
  const updateResult = await db.userSession.updateMany({
    where: {
      id: toId(sessionId),
      role: "worker",
      refreshTokenHash: expectedCurrentHash,
    },
    data: {
      refreshTokenHash,
      lastActiveAt: updatedAt,
      updatedAt,
    },
  });

  if (updateResult.count === 0) {
    return null;
  }

  return requireMapped(
    mapWorkerSession(
      await db.userSession.findUnique({
        where: {
          id: toId(sessionId),
        },
      })
    ),
    "WorkerSession",
    "update"
  );
}

// Function revoke active session จาก DB
export async function revoke(
  sessionId: number | string,
  connection?: DbConnection
): Promise<SessionDto | null> {
  const db = client(connection);
  const activeSession = await db.userSession.findFirst({
    where: {
      id: toId(sessionId),
      role: "worker",
      isActive: true,
    },
  });

  if (!activeSession) {
    return null;
  }

  return mapWorkerSession(
    await db.userSession.update({
      where: {
        id: activeSession.id,
      },
      data: buildRevokeData(),
    })
  );
}

// Function เพิกถอน active ตาม worker ID จาก DB
export async function revokeActiveByWorkerId(
  workerId: number | string,
  connection?: DbConnection
): Promise<void> {
  await client(connection).userSession.updateMany({
    where: {
      role: "worker",
      workerId: toId(workerId),
      isActive: true,
    },
    data: buildRevokeData(),
  });
}
