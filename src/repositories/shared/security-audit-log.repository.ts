// Import Library
import { Prisma } from "@prisma/client";
import type { SecurityAuditLog } from "@prisma/client";
// Import Utils
import { client } from "./repository-utils";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";
import type { SecurityAuditLogDto, SecurityAuditLogWriteInput } from "../../types/shared/security-audit-log.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function map record จาก DB เป็น DTO ตรงๆ (ไม่มี relation ให้ join เพราะ actor เป็น snapshot ที่เขียนไว้แล้ว)
function mapSecurityAuditLog(record: SecurityAuditLog): SecurityAuditLogDto {
  return {
    id: record.id,
    event_type: record.eventType,
    outcome: record.outcome,
    actor_type: record.actorType,
    actor_account_id: record.actorAccountId,
    actor_worker_id: record.actorWorkerId,
    actor_username: record.actorUsername,
    actor_full_name: record.actorFullName,
    session_id: record.sessionId,
    request_id: record.requestId,
    ip_address: record.ipAddress,
    user_agent: record.userAgent,
    failure_code: record.failureCode,
    metadata: (record.metadata as Record<string, unknown> | null) ?? null,
    created_at: record.createdAt.toISOString(),
  };
}

// Function บันทึก Security/Auth event ลง DB — throw ตามปกติเมื่อเขียนไม่สำเร็จ ผู้เรียกเป็นคนตัดสินใจว่าจะ
// ปล่อยให้ throw (rollback transaction ที่ผูกด้วย) หรือ catch แบบ best-effort (เช่น login ที่ถูกปฏิเสธ)
export async function create(
  input: SecurityAuditLogWriteInput,
  connection?: DbConnection
): Promise<SecurityAuditLogDto> {
  const db = client(connection);
  const record = await db.securityAuditLog.create({
    data: {
      eventType: input.event_type,
      outcome: input.outcome,
      actorType: input.actor_type ?? null,
      actorAccountId: input.actor_account_id ?? null,
      actorWorkerId: input.actor_worker_id ?? null,
      actorUsername: input.actor_username ?? null,
      actorFullName: input.actor_full_name ?? null,
      sessionId: input.session_id ?? null,
      requestId: input.request_id ?? null,
      ipAddress: input.ip_address ?? null,
      userAgent: input.user_agent ?? null,
      failureCode: input.failure_code ?? null,
      metadata: input.metadata
        ? (input.metadata as Prisma.InputJsonValue)
        : Prisma.JsonNull,
    },
  });

  return mapSecurityAuditLog(record);
}

// Function ลบ SecurityAuditLog ที่เก่ากว่า cutoff (ใช้โดย retention cleanup job รายวัน) คืนจำนวนแถวที่ลบ
export async function deleteOlderThan(
  cutoff: Date,
  connection?: DbConnection
): Promise<number> {
  const db = client(connection);
  const result = await db.securityAuditLog.deleteMany({
    where: { createdAt: { lt: cutoff } },
  });

  return result.count;
}
