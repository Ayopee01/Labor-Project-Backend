// Import Utils
import { client } from "./repository-utils";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function เพิกถอน driver session ที่ยัง active ทั้งหมดของ vehicle job นี้ (เรียกตอนงานจบ/ถูกยกเลิก)
export async function revokeDriverSessionsByTicketJobId(
  ticketJobId: number,
  connection?: DbConnection,
): Promise<void> {
  const db = client(connection);

  await db.driverSession.updateMany({
    where: {
      ticketJobId,
      revokedAt: null,
    },
    data: {
      revokedAt: new Date(),
    },
  });
}
