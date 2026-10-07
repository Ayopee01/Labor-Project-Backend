// Import Library
import argon2 from "argon2";
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

// Function อ่าน env เป็นจำนวนเต็มบวก ถ้าไม่ตั้ง/ผิดรูปแบบใช้ค่า default
function positiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// Config จำนวน argon2 verify ที่รันพร้อมกันได้ (กัน CPU thrash ตอน login พร้อมกันเยอะ — ควร ≈ จำนวน vCPU)
const ARGON2_MAX_CONCURRENCY = positiveIntEnv("ARGON2_MAX_CONCURRENCY", 4);
// Config จำนวนคิวรอสูงสุด เกินกว่านี้ตอบ 503 ทันที (fail fast กันงานกองจน CPU/หน่วยความจำตัน)
const ARGON2_MAX_QUEUE = positiveIntEnv("ARGON2_MAX_QUEUE", 200);

/* -------------------------------------- Argon2 Concurrency Limiter -------------------------------------- */

// Semaphore จำกัดจำนวน argon2 verify ที่รันพร้อมกัน + คิวรอแบบมีเพดาน
let argon2Active = 0;
const argon2Waiters: Array<() => void> = [];

// Function จองสิทธิ์รัน argon2 — เกินเพดานคิวจะ throw 503 ให้ fail fast
function acquireArgon2Slot(): Promise<void> {
  if (argon2Active < ARGON2_MAX_CONCURRENCY) {
    argon2Active += 1;
    return Promise.resolve();
  }

  if (argon2Waiters.length >= ARGON2_MAX_QUEUE) {
    return Promise.reject(
      new ApiError(503, "SERVER_BUSY", "Server is busy. Please try again shortly.")
    );
  }

  return new Promise((resolve) => {
    argon2Waiters.push(resolve);
  });
}

// Function คืนสิทธิ์ — ถ้ามีคิวรออยู่ส่งสิทธิ์ให้ตัวถัดไป (ไม่ลด active) ไม่งั้นลด active
function releaseArgon2Slot(): void {
  const next = argon2Waiters.shift();
  if (next) {
    next();
    return;
  }
  argon2Active -= 1;
}

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

  // throw 503 ที่นี่ได้ถ้าคิวเต็ม (fail fast) — ยังไม่ได้จองสิทธิ์จึงไม่ต้อง release
  await acquireArgon2Slot();

  try {
    return await argon2.verify(passwordHash, password);
  } catch {
    return false;
  } finally {
    releaseArgon2Slot();
  }
}
