/* -------------------------------------- Functions -------------------------------------- */

// Function อ่านจำนวน active device สูงสุดต่อ vehicle job หนึ่งคัน (default/production ต้องเป็น 2 ตามสเปค)
export function getDriverActiveDeviceLimit(): number {
  const value = Number(process.env.DRIVER_ACTIVE_DEVICE_LIMIT);

  return Number.isInteger(value) && value > 0 ? value : 2;
}

// Function อ่านระยะเวลา grace period (ms) ที่ session เดิมยังอ่าน snapshot สุดท้ายได้หลังรถเข้า terminal
export function getDriverTerminalSessionGraceMs(): number {
  const minutes = Number(process.env.DRIVER_TERMINAL_SESSION_GRACE_MINUTES);
  const safeMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 30;

  return safeMinutes * 60 * 1000;
}

// Function อ่านจำนวน SSE connection สูงสุดต่อ Driver Session หนึ่งอัน (รองรับ reload/เปิดซ้ำชั่วคราว) —
// คนละชั้นกับ DRIVER_ACTIVE_DEVICE_LIMIT (จำกัดจำนวน "เครื่อง" ไม่ใช่จำนวน "connection")
export function getDriverStreamConnectionLimit(): number {
  const value = Number(process.env.DRIVER_STREAM_CONNECTION_LIMIT);

  return Number.isInteger(value) && value > 0 ? value : 2;
}

// Function ประกอบ base URL ของ Driver Web (ตัด "/" ท้ายออกกันซ้ำตอนต่อ path)
export function getDriverWebBaseUrl(): string {
  const value = process.env.DRIVER_WEB_BASE_URL;

  if (!value) {
    throw new Error("DRIVER_WEB_BASE_URL must be set to build the Driver QR URL.");
  }

  return value.replace(/\/+$/, "");
}
