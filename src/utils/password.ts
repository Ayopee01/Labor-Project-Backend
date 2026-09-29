// Import Library
import argon2 from "argon2";

/* -------------------------------------- Config -------------------------------------- */

// Config option ของ argon2 ที่ใช้ hash password
const ARGON2_OPTIONS = {
  type: argon2.argon2id,
} as const;

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

// Function hash password ด้วย argon2
export async function hashPassword(password: string): Promise<string> {
  assertPassword(password);

  return argon2.hash(password, ARGON2_OPTIONS);
}

// Function เทียบ password กับ hash (hash ว่างหรือผิดรูปแบบคืน false)
export async function verifyPassword(
  password: string,
  passwordHash: string | null | undefined
): Promise<boolean> {
  assertPassword(password);

  if (typeof passwordHash !== "string" || passwordHash.length === 0) {
    return false;
  }

  try {
    return await argon2.verify(passwordHash, password);
  } catch {
    return false;
  }
}
