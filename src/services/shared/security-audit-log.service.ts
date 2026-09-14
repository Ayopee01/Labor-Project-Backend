// Import Repositories
import * as securityAuditLogRepository from "../../repositories/shared/security-audit-log.repository";
// Import Utils
import { logger } from "../../utils/logger";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";
import type { SecurityAuditLogWriteInput } from "../../types/shared/security-audit-log.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function อ่านจำนวนวันเก็บ SecurityAuditLog จาก Env ตรงจุดที่ใช้จริง — Throw ถ้าไม่มีค่าหรือไม่ใช่
// ตัวเลขบวก กันไม่ให้ retention เพี้ยนไปเงียบๆ โดยไม่มีใครรู้ตัว
function getSecurityAuditLogRetentionDays(): number {
  const value = Number(process.env.SECURITY_AUDIT_LOG_RETENTION_DAYS);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("SECURITY_AUDIT_LOG_RETENTION_DAYS must be set to a positive number.");
  }

  return value;
}

// Function เขียน Security Audit event ของ mutation ที่สำเร็จ — ต้องเรียกในทรานแซกชันเดียวกับการ
// เปลี่ยนข้อมูลจริงเสมอ ไม่ catch error ที่นี่ เพื่อให้ transaction rollback ถ้าเขียน log ไม่สำเร็จ
export async function writeSecurityAuditLog(
  input: SecurityAuditLogWriteInput,
  connection: DbConnection
): Promise<void> {
  await securityAuditLogRepository.create(input, connection);
}

// Function เขียน Security Audit event แบบ best-effort สำหรับกรณีไม่มี mutation อื่นให้ผูก atomicity
// (เช่น auth_login_failed) — catch error เอง กันไม่ให้เขียน log พลาดจนทำ response ที่ถูกต้องอยู่แล้วกลายเป็น 500
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

// Function เทียบ field ที่ระบุระหว่าง before/after คืนเฉพาะ field ที่เปลี่ยนจริง (ไม่ snapshot ทั้ง
// record) คืน null ถ้าไม่มี field ไหนเปลี่ยนเลย เพื่อไม่ให้เขียน event ที่ before === after ทุก field
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

// Function ลบ SecurityAuditLog ที่เก่ากว่า retention — เรียกโดย cleanup job รายวัน ไม่ throw ออกไปเอง
// เพื่อให้ worker แค่ log error แล้วรอรอบถัดไป
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
