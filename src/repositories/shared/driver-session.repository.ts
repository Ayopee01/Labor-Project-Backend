// Import Config
import { getDriverTerminalSessionGraceMs } from "../../config/driver.config";
// Import Mappers
import { client } from "./repository-utils";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function revoke driver session ทั้งหมดของงานรถตอนงานจบ โดยให้อ่านต่อได้ช่วง grace period
export async function revokeDriverSessionsByTicketJobId(
  ticketJobId: number,
  connection?: DbConnection,
): Promise<void> {
  const db = client(connection);
  const now = new Date();
  const readOnlyUntil = new Date(now.getTime() + getDriverTerminalSessionGraceMs());

  await db.driverSession.updateMany({
    where: {
      ticketJobId,
      revokedAt: null,
    },
    data: {
      revokedAt: now,
      readOnlyUntil,
    },
  });
}
