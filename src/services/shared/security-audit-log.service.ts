// Import Repositories
import * as securityAuditLogRepository from "../../repositories/shared/security-audit-log.repository";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";
import type { SecurityAuditLogWriteInput } from "../../types/shared/security-audit-log.type";
// Import Utils
import { logger } from "../../utils/logger";

/* -------------------------------------- Functions -------------------------------------- */

// Function อ่านจำนวนวันเก็บ SecurityAuditLog จาก env (ไม่ใช่เลขบวก throw)
function getSecurityAuditLogRetentionDays(): number {
  const value = Number(process.env.SECURITY_AUDIT_LOG_RETENTION_DAYS);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("SECURITY_AUDIT_LOG_RETENTION_DAYS must be set to a positive number.");
  }

  return value;
}

// Function เขียน Security Audit event ใน transaction เดียวกับการแก้ข้อมูล (ไม่ catch เพื่อให้ rollback)
export async function writeSecurityAuditLog(
  input: SecurityAuditLogWriteInput,
  connection: DbConnection
): Promise<void> {
  await securityAuditLogRepository.create(input, connection);
}

// Function เขียน Security Audit event แบบ best-effort (เช่น login ไม่สำเร็จ) โดย catch error เอง
export async function writeSecurityAuditLogBestEffort(
  input: SecurityAuditLogWriteInput
): Promise<void> {
  try {
    await securityAuditLogRepository.create(input);
  } catch (error) {
    logger.error("Failed to persist security audit log.", {
      error,
      event_type: input.event_type,
    });
  }
}

// Function เทียบ field ที่ระบุระหว่าง before/after คืนเฉพาะที่เปลี่ยน (ไม่เปลี่ยนเลยคืน null)
export function diffChangedFields<T extends object>(
  before: T,
  after: T,
  fields: ReadonlyArray<keyof T & string>
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const beforeRecord = before as Record<string, unknown>;
  const afterRecord = after as Record<string, unknown>;
  const beforeDiff: Record<string, unknown> = {};
  const afterDiff: Record<string, unknown> = {};
  let hasChange = false;

  for (const field of fields) {
    if (beforeRecord[field] !== afterRecord[field]) {
      beforeDiff[field] = beforeRecord[field] ?? null;
      afterDiff[field] = afterRecord[field] ?? null;
      hasChange = true;
    }
  }

  return hasChange ? { before: beforeDiff, after: afterDiff } : null;
}

// Function ลบ SecurityAuditLog ที่เก่ากว่า retention (cleanup job รายวัน ไม่ throw ออกไป)
export async function runSecurityAuditLogRetentionCleanup(): Promise<number> {
  const retentionDays = getSecurityAuditLogRetentionDays();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const deletedCount = await securityAuditLogRepository.deleteOlderThan(cutoff);

  logger.info("Security audit log retention cleanup completed.", {
    deletedCount,
    cutoff: cutoff.toISOString(),
    retentionDays,
  });

  return deletedCount;
}
