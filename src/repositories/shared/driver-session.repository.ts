// Import Config
import { getDriverTerminalSessionGraceMs } from "../../config/driver.config";
// Import Utils
import { client } from "./repository-utils";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function เพิกถอน driver session ที่ยัง active ทั้งหมดของ vehicle job นี้ (เรียกตอนงานจบ/ถูกยกเลิก) —
// ตั้ง readOnlyUntil ไว้ด้วยเสมอ เพื่อให้ session เดิมยังอ่าน snapshot สุดท้ายได้แบบ read-only ต่ออีก
// DRIVER_TERMINAL_SESSION_GRACE_MINUTES ก่อนถือว่าหมดอายุจริง (ดู findUsableDriverSessionByToken)
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
