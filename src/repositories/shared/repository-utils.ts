// Import Library
import { randomBytes } from "crypto";
// Import Config
import { prisma } from "../../db/prisma";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function เลือก Prisma client หรือ transaction client ที่ส่งเข้ามา
export function client(connection?: DbConnection): DbConnection {
  return connection ?? prisma;
}

// Function แปลง id เป็น number สำหรับ query DB
export function toId(id: number | string): number {
  return Number(id);
}

// Function ตรวจสอบว่า record ที่ map แล้วไม่เป็น null มิฉะนั้น throw error
export function requireMapped<T>(
  record: T | null | undefined,
  subject: string,
  action: string,
): T {
  if (!record) {
    throw new Error(`${subject} ${action} did not return a record.`);
  }

  return record;
}

// Function สร้าง random token พร้อม prefix
export function createRandomToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("hex")}`;
}

// Function ตรวจสอบว่า DTO ไม่เป็น null มิฉะนั้น throw error
export function requireDto<TDto>(value: TDto | null, name: string): TDto {
  if (!value) {
    throw new Error(`${name} did not return a record.`);
  }

  return value;
}

// Function สร้าง data object สำหรับ revoke session (isActive=false, revokedAt/updatedAt=ปัจจุบัน)
export function buildRevokeData(): {
  isActive: false;
  revokedAt: Date;
  updatedAt: Date;
} {
  const revokedAt = new Date();

  return {
    isActive: false,
    revokedAt,
    updatedAt: revokedAt,
  };
}
