// Import Library
import argon2 from "argon2";
import PQueue from "p-queue";
// Import Config
import { readPositiveIntegerEnv } from "../config/env";
// Import Utils
import ApiError from "./api-error";

/* -------------------------------------- Config -------------------------------------- */

// Config option ของ argon2 ที่ใช้ hash password (ตั้ง cost ตาม OWASP ขั้นต่ำเพื่อลดภาระ RAM/CPU ตอน login พร้อมกันจำนวนมาก — hash เดิมฝัง param ไว้ในตัวจึง verify ได้ปกติ)
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

// Config จำนวน argon2 verify ที่รันพร้อมกันได้ (กัน CPU thrash ตอน login พร้อมกันเยอะ — ควร ≈ จำนวน vCPU)
const ARGON2_MAX_CONCURRENCY = readPositiveIntegerEnv("ARGON2_MAX_CONCURRENCY", 4);
// Config จำนวนคิวรอสูงสุด เกินกว่านี้ตอบ 503 ทันที (fail fast กันงานกองจน CPU/หน่วยความจำตัน)
const ARGON2_MAX_QUEUE = readPositiveIntegerEnv("ARGON2_MAX_QUEUE", 200);

// Config คิวจำกัดจำนวน argon2 verify ที่รันพร้อมกัน
const argon2Queue = new PQueue({ concurrency: ARGON2_MAX_CONCURRENCY });

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจว่า password เป็นข้อความที่ไม่ว่าง
function assertPassword(password: string): void {
  if (typeof password !== "string" || password.length === 0) {
    throw new TypeError("Password must be a non-empty string.");
  }
}

// Function ตัดอักขระที่ไม่ใช่ตัวเลขออกจากเบอร์โทร (ใช้ทั้งตอนบันทึกเบอร์และสร้าง password worker)
export function normalizePhoneDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}

// Function hash password ด้วย argon2 (ไม่ผ่าน limiter — ใช้ตอน seed/เปลี่ยนรหัส ไม่ใช่ hot path ของ login)
export async function hashPassword(password: string): Promise<string> {
  assertPassword(password);

  return argon2.hash(password, ARGON2_OPTIONS);
}

// Function เทียบ password กับ hash (hash ว่างหรือผิดรูปแบบคืน false) — ผ่าน limiter กัน CPU ตันตอน login พร้อมกันเยอะ
export async function verifyPassword(
  password: string,
  passwordHash: string | null | undefined
): Promise<boolean> {
  assertPassword(password);

  if (typeof passwordHash !== "string" || passwordHash.length === 0) {
    return false;
  }

  // คิวรอเต็ม = ตอบ 503 ทันที (fail fast)
  if (argon2Queue.size >= ARGON2_MAX_QUEUE) {
    throw new ApiError(503, "SERVER_BUSY", "Server is busy. Please try again shortly.");
  }

  return argon2Queue.add(async () => {
    try {
      return await argon2.verify(passwordHash, password);
    } catch {
      return false;
    }
  });
}
