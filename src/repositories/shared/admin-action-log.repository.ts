// Import Library
import { Prisma } from "@prisma/client";
// Import Mappers
import { mapAdminActionLog } from "./mappers";
import { client, requireDto } from "./repository-utils";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";
import type { AdminActionLogDto, AdminActionLogWriteInput } from "../../types/shared/admin-action-log.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function บันทึก Admin action ลง DB
export async function create(
  input: AdminActionLogWriteInput,
  connection?: DbConnection
): Promise<AdminActionLogDto> {
  const db = client(connection);
  const record = await db.adminActionLog.create({
    data: {
      ticketJobId: input.vehicle_job_id ?? null,
      boothJobId: input.gate_ticket_id ?? null,
      marketJobId: input.market_job_id ?? null,
      actionType: input.action_type,
      reasonCode: input.reason_code ?? null,
      reasonText: input.reason_text ?? null,
      actorAccountId: input.actor_account_id,
      metadata: input.metadata
        ? (input.metadata as Prisma.InputJsonValue)
        : Prisma.JsonNull,
    },
    include: {
      actor: true,
    },
  });

  return requireDto(mapAdminActionLog(record), "admin action log create");
}

// Function ดึงประวัติ Admin action ของ TicketJob จาก DB สำหรับ Work History Timeline
export async function listByTicketJobId(
  ticketJobId: number,
  connection?: DbConnection
): Promise<AdminActionLogDto[]> {
  const db = client(connection);
  const records = await db.adminActionLog.findMany({
    where: {
      ticketJobId,
    },
    orderBy: {
      createdAt: "asc",
    },
    include: {
      actor: true,
    },
  });

  return records
    .map((record) => mapAdminActionLog(record))
    .filter((record): record is AdminActionLogDto => record !== null);
}
