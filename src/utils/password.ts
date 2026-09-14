// Import Library
import argon2 from "argon2";

/* -------------------------------------- Config -------------------------------------- */

const ARGON2_OPTIONS = {
  type: argon2.argon2id,
};

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจสอบเงื่อนไข password สำหรับ helper กลาง
function assertPassword(password: string): void {
  if (typeof password !== "string" || password.length === 0) {
    throw new TypeError("Password must be a non-empty string.");
  }
}

// Function ตัดอักขระที่ไม่ใช่ตัวเลขออกจากเบอร์โทร (เช่น "081-234-5678" หรือ "081-2345678" ->
// "0812345678") ใช้ทั้งตอนบันทึกลง telephone/phone column และตอนสร้าง password ของ Worker จากเบอร์นี้
// เพื่อไม่ให้เบอร์ที่พิมพ์มามีขีด/วงเล็บ/เว้นวรรคต่างกันหลุดลง DB แล้ว auth เข้าไม่ได้ด้วยตัวเลขล้วน
export function normalizePhoneDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}

// Function hash password สำหรับ helper กลาง
export async function hashPassword(password: string): Promise<string> {
  assertPassword(password);

  return argon2.hash(password, ARGON2_OPTIONS);
}

// Function ตรวจสอบ password สำหรับ helper กลาง
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
