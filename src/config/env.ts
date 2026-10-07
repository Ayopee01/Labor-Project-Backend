// Import Library
import { z } from "zod";

/* -------------------------------------- Config -------------------------------------- */

// Config schema ของค่า env แต่ละรูปแบบ (ค่าว่าง/ไม่ตั้งแปลงเป็น 0 หรือ NaN จึงไม่ผ่าน positive)
const ENV_SCHEMAS = {
  requiredString: z.string().min(1),
  positiveNumber: z.coerce.number().positive(),
  positiveInteger: z.coerce.number().int().positive(),
};

/* -------------------------------------- Functions -------------------------------------- */

// Function อ่านค่า env ที่ต้องมี ถ้าไม่มีให้ Throw Error ทันที
export function readRequiredEnv(name: string): string {
  const result = ENV_SCHEMAS.requiredString.safeParse(process.env[name]);

  if (!result.success) {
    throw new Error(`${name} is required`);
  }

  return result.data;
}

// Function อ่าน env เป็นจำนวนบวก (ไม่ส่ง fallback = บังคับตั้ง ถ้าไม่ตั้ง/ผิดรูปแบบ throw, ส่ง fallback = ใช้ค่า default แทน)
export function readPositiveNumberEnv(name: string, fallback?: number): number {
  const result = ENV_SCHEMAS.positiveNumber.safeParse(process.env[name]);

  if (result.success) {
    return result.data;
  }

  if (fallback === undefined) {
    throw new Error(`${name} must be set to a positive number.`);
  }

  return fallback;
}

// Function อ่าน env เป็นจำนวนเต็มบวก (ไม่ส่ง fallback = บังคับตั้ง ถ้าไม่ตั้ง/ผิดรูปแบบ throw, ส่ง fallback = ใช้ค่า default แทน)
export function readPositiveIntegerEnv(name: string, fallback?: number): number {
  const result = ENV_SCHEMAS.positiveInteger.safeParse(process.env[name]);

  if (result.success) {
    return result.data;
  }

  if (fallback === undefined) {
    throw new Error(`${name} must be set to a positive integer.`);
  }

  return fallback;
}
