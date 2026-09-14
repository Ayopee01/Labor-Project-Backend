// Import Mappers
import { mapAccount, mapSession } from "./shared/mappers";
import { buildRevokeData, client, requireMapped, toId } from "./shared/repository-utils";
// Import Types
import type { DbConnection } from "../types/shared/common.type";
import type { PendingSessionInput, SessionDto } from "../types/auth.type";
import type { AccountDto } from "../types/admin-workers.type";

/* -------------------------------------- Config -------------------------------------- */

// Config ค่า refresh token hash ชั่วคราวสำหรับ pending session ก่อนออก token จริง
const PENDING_REFRESH_TOKEN_HASH = "";

/* -------------------------------------- Functions -------------------------------------- */

// Function ค้นหา account ตาม username จาก DB
export async function findByUsername(
  username: string,
  connection?: DbConnection,
): Promise<AccountDto | null> {
  const account = await client(connection).account.findUnique({
    where: {
      username,
    },
  });

  return mapAccount(account);
}

// Function สร้าง pending session data จาก DB
function buildPendingSessionData(session: PendingSessionInput) {
  return {
    role: "admin",
    accountId: session.account_id,
    refreshTokenHash: PENDING_REFRESH_TOKEN_HASH,
    deviceId: session.device_id,
    deviceName: session.device_name,
    ipAddress: session.ip_address ?? null,
    userAgent: session.user_agent ?? null,
    expiresAt: new Date(session.expires_at),
  };
}

// Function สร้าง refresh token hash data จาก DB
function buildRefreshTokenHashData(refreshTokenHash: string) {
  const updatedAt = new Date();

  return {
    refreshTokenHash,
    lastActiveAt: updatedAt,
    updatedAt,
  };
}

// Function ค้นหา active session ตาม ID จาก DB
export async function findActiveById(
  sessionId: number | string,
  connection?: DbConnection,
): Promise<SessionDto | null> {
  return mapSession(
    await client(connection).userSession.findFirst({
      where: {
        id: toId(sessionId),
        role: "admin",
        isActive: true,
        expiresAt: {
          gt: new Date(),
        },
      },
    }),
  );
}

// Function สร้าง pending session จาก DB
export async function createPending(
  session: PendingSessionInput,
  connection?: DbConnection,
): Promise<SessionDto> {
  return requireMapped(
    mapSession(
      await client(connection).userSession.create({
        data: buildPendingSessionData(session),
      }),
    ),
    "Session",
    "create",
  );
}

// Function อัปเดต refresh token hash จาก DB — เขียนแบบมีเงื่อนไข (ต้องตรงกับ expectedCurrentHash เดิม)
// กัน TOCTOU race เมื่อมี /auth/refresh พร้อมกันหลาย request ด้วย token เดิม คืน null เมื่อแพ้ race
export async function updateRefreshTokenHash(
  sessionId: number | string,
  refreshTokenHash: string,
  expectedCurrentHash: string,
  connection?: DbConnection,
): Promise<SessionDto | null> {
  const db = client(connection);
  const updateResult = await db.userSession.updateMany({
    where: {
      id: toId(sessionId),
      role: "admin",
      refreshTokenHash: expectedCurrentHash,
    },
    data: buildRefreshTokenHashData(refreshTokenHash),
  });

  if (updateResult.count === 0) {
    return null;
  }

  return requireMapped(
    mapSession(
      await db.userSession.findUnique({
        where: {
          id: toId(sessionId),
        },
      }),
    ),
    "Session",
    "update",
  );
}

// Function revoke active session จาก DB
export async function revoke(
  sessionId: number | string,
  connection?: DbConnection,
): Promise<SessionDto | null> {
  const db = client(connection);
  const activeSession = await db.userSession.findFirst({
    where: {
      id: toId(sessionId),
      role: "admin",
      isActive: true,
    },
  });

  if (!activeSession) {
    return null;
  }

  return mapSession(
    await db.userSession.update({
      where: {
        id: activeSession.id,
      },
      data: buildRevokeData(),
    }),
  );
}
