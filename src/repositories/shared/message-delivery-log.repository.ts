// Import Library
import type { Prisma } from "@prisma/client";
// Import Utils
import { client } from "./repository-utils";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";

/* -------------------------------------- Config -------------------------------------- */

// Config สถานะของ message delivery log — table นี้ใช้ร่วมกันทั้ง fcm_push และ LINE channel
export const MESSAGE_DELIVERY_STATUS = {
  PENDING: "PENDING",
  SENT: "SENT",
  FAILED: "FAILED",
} as const;

/* -------------------------------------- Functions -------------------------------------- */

// Function สร้าง message delivery log จาก DB
export async function createMessageDeliveryLog(
  channel: string,
  jobName: string,
  payload: Prisma.InputJsonValue,
  target?: string | null,
  connection?: DbConnection
): Promise<number> {
  const db = client(connection);
  const log = await db.messageDeliveryLog.create({
    data: {
      channel,
      jobName,
      target: target ?? null,
      payload,
      status: MESSAGE_DELIVERY_STATUS.PENDING,
    },
  });

  return log.id;
}

// Function อัปเดต message delivery log status จาก DB
export async function updateMessageDeliveryLogStatus(
  id: number,
  status: string,
  error?: string | null,
  connection?: DbConnection
): Promise<void> {
  const db = client(connection);
  await db.messageDeliveryLog.update({
    where: {
      id,
    },
    data: {
      status,
      lastError: error ?? null,
      sentAt: status === MESSAGE_DELIVERY_STATUS.SENT ? new Date() : undefined,
    },
  });
}
