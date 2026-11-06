// Import Library
import crypto from "crypto";

/* -------------------------------------- Config -------------------------------------- */

// Config ชื่อ header ของ request id
export const REQUEST_ID_HEADER = "x-request-id";
// Config Pattern ของ request id ที่อนุญาตให้ใช้ (ตัวอักษร A-Z, a-z, 0-9, - และ _ ความยาวไม่เกิน 128 ตัวอักษร)
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/* -------------------------------------- Functions -------------------------------------- */

// Function ใช้ request id จาก header (ถ้าถูกรูปแบบ) หรือสร้างใหม่
export function resolveRequestId(inbound: string | undefined): string {
  return inbound && REQUEST_ID_PATTERN.test(inbound) ? inbound : crypto.randomUUID();
}
