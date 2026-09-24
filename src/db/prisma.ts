// Import Library
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Import Types
import type { TransactionCallback } from "../types/shared/common.type";

dotenv.config({ quiet: true });

/* -------------------------------------- Functions -------------------------------------- */

// Function อ่าน DATABASE_URL และโยน error ทันทีถ้ายังไม่ได้ตั้งค่า
function getDatabaseUrl(): string {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL must be configured before using Prisma.");
  }

  return process.env.DATABASE_URL;
}

// Function อ่านขนาด pool สูงสุดจาก DATABASE_POOL_MAX — ปล่อยว่างไว้ก็ยังปลอดภัยเพราะ default เป็นค่าเดิมของ pg เอง (10)
function getDatabasePoolMax(): number {
  const raw = process.env.DATABASE_POOL_MAX;
  if (!raw) {
    return 10;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("DATABASE_POOL_MAX must be a positive integer when set.");
  }

  return parsed;
}

// Function สร้าง Prisma client พร้อม adapter ของ PostgreSQL
function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: getDatabaseUrl(),
    max: getDatabasePoolMax(),
  });

  // cast กลับเป็น PrismaClient เพราะ client ที่ตั้ง global omit เป็นคนละ type กับ DbConnection/TransactionClient ทั้งระบบ
  // ผลคือ type ยังบอกว่ามี MasterWorker.picture แต่ runtime จะเป็น undefined — ห้ามอ่าน .picture โดยไม่ขอ omit: { picture: false }
  return new PrismaClient({
    adapter,
    // ไม่ดึง MasterWorker.picture (binary รูปรวม ~40MB ทั้งตาราง) ทุกครั้งที่ query worker เพราะไม่มี response
    // ไหนใช้ — ที่ต้องใช้รูปจริง (เช่นอัปโหลดขึ้น Spaces) ให้ขอเองด้วย omit: { picture: false } หรือ select
    omit: {
      masterWorker: {
        picture: true,
      },
    },
    log:
      process.env.PRISMA_QUERY_LOG === "true"
        ? ["query", "error", "warn"]
        : ["error", "warn"],
  }) as unknown as PrismaClient;
}

// Function คืน Prisma client ตัวเดียวของ process เพื่อใช้ซ้ำทั้งระบบ
export function getPrisma(): PrismaClient {
  if (!global.prismaClient) {
    global.prismaClient = createPrismaClient();
  }

  return global.prismaClient;
}

// Function proxy ให้ import prisma ได้ทันที แต่สร้าง client จริงแบบ lazy
export const prisma = new Proxy({} as PrismaClient, {
  get(target, property, receiver) {
    return Reflect.get(getPrisma(), property, receiver ?? target);
  },
});

// Function ครอบ workflow ที่ต้องเขียนหลาย table ให้อยู่ใน transaction เดียว
export async function withTransaction<T>(
  callback: TransactionCallback<T>
): Promise<T> {
  return getPrisma().$transaction(callback);
}

// Function ปิด Prisma client สำหรับ test หรือ graceful shutdown
export async function closePrisma(): Promise<void> {
  if (!global.prismaClient) {
    return;
  }

  await global.prismaClient.$disconnect();
  global.prismaClient = null;
}
