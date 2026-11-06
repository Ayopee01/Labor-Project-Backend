// Import Config
import { readPositiveIntegerEnv, readPositiveNumberEnv, readRequiredEnv } from "./env";

/* -------------------------------------- Functions -------------------------------------- */

// Function อ่านจำนวน active device สูงสุดต่อ vehicle job หนึ่งคัน (default/production ต้องเป็น 2 ตามสเปค)
export function getDriverActiveDeviceLimit(): number {
  return readPositiveIntegerEnv("DRIVER_ACTIVE_DEVICE_LIMIT", 2);
}

// Function อ่านระยะเวลา grace period (ms) ที่ session เดิมยังอ่าน snapshot สุดท้ายได้หลังรถเข้า terminal
export function getDriverTerminalSessionGraceMs(): number {
  return readPositiveNumberEnv("DRIVER_TERMINAL_SESSION_GRACE_MINUTES", 30) * 60 * 1000;
}

// Function อ่านจำนวน SSE connection สูงสุดต่อ Driver Session (ต่างจาก active device limit ที่นับเครื่อง)
export function getDriverStreamConnectionLimit(): number {
  return readPositiveIntegerEnv("DRIVER_STREAM_CONNECTION_LIMIT", 2);
}

// Function ประกอบ base URL ของ Driver Web (ตัด "/" ท้ายออกกันซ้ำตอนต่อ path)
export function getDriverWebBaseUrl(): string {
  return readRequiredEnv("DRIVER_WEB_BASE_URL").replace(/\/+$/, "");
}
