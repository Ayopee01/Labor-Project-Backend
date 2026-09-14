// Import Library
import type { Prisma } from "@prisma/client";
// Import Mappers
import { mapSession } from "./mappers";
import { buildRevokeData, client, toId } from "./repository-utils";
// Import Types
import type { SessionDto } from "../../types/auth.type";
import type { DbConnection } from "../../types/shared/common.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function ประกอบเงื่อนไข where สำหรับ session ที่ยัง active (isActive และยังไม่หมดอายุ)
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

// Function ค้นหา active ตาม account ID จาก DB
export async function findActiveByAccountId(
  accountId: number | string,
  connection?: DbConnection
): Promise<SessionDto | null> {
  return mapSession(
    await client(connection).userSession.findFirst({
      where: buildActiveSessionWhere({
        role: "admin",
        accountId: toId(accountId),
      }),
      orderBy: {
        id: "desc",
      },
    })
  );
}

// Function เพิกถอน active ตาม account ID จาก DB
export async function revokeActiveByAccountId(
  accountId: number | string,
  connection?: DbConnection
): Promise<void> {
  await client(connection).userSession.updateMany({
    where: {
      role: "admin",
      accountId: toId(accountId),
      isActive: true,
    },
    data: buildRevokeData(),
  });
}

// Function เพิกถอน active session ทั้งหมดของ account ยกเว้น session ที่ระบุ จาก DB
export async function revokeActiveByAccountIdExcept(
  accountId: number | string,
  exceptSessionId: number | string,
  connection?: DbConnection
): Promise<number> {
  const result = await client(connection).userSession.updateMany({
    where: {
      role: "admin",
      accountId: toId(accountId),
      id: {
        not: toId(exceptSessionId),
      },
      isActive: true,
    },
    data: buildRevokeData(),
  });

  return result.count;
}
