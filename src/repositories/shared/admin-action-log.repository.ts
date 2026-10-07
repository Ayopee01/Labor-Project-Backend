// Import Library
import { Prisma } from "@prisma/client";
// Import Repositories
import { client, requireDto } from "./repository-utils";
// Import Mappers
import { mapAdminActionLog } from "./mappers";
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
      actorGateClientId: input.actor_gate_client_id ?? null,
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

// Function ดึงประวัติ Admin action ของหลาย TicketJob ใน query เดียว แล้วจัดกลุ่มตาม TicketJob
export async function listByTicketJobIds(
  ticketJobIds: number[],
  connection?: DbConnection
): Promise<Map<number, AdminActionLogDto[]>> {
  const logsByTicketJobId = new Map<number, AdminActionLogDto[]>(
    ticketJobIds.map((ticketJobId) => [ticketJobId, []])
  );

  if (ticketJobIds.length === 0) {
    return logsByTicketJobId;
  }

  const db = client(connection);
  const records = await db.adminActionLog.findMany({
    where: {
      ticketJobId: {
        in: ticketJobIds,
      },
    },
    orderBy: [
      {
        createdAt: "asc",
      },
      {
        id: "asc",
      },
    ],
    include: {
      actor: true,
      actorGateClient: {
        select: {
          name: true,
        },
      },
    },
  });

  for (const record of records) {
    const log = mapAdminActionLog(record);

    if (log && record.ticketJobId !== null) {
      logsByTicketJobId.get(record.ticketJobId)?.push(log);
    }
  }

  return logsByTicketJobId;
}
