// Import Library
import { AsyncLocalStorage } from "async_hooks";

/* -------------------------------------- Types -------------------------------------- */

// Type ข้อมูลอ้างอิงที่แนบไปกับทุก log และ Sentry event ของ request/job เดียวกัน
export interface LogContext {
  requestId?: string;
  jobName?: string;
  jobId?: string;
  ticketJobId?: number;
  ticketNumber?: string;
  ticketNo?: string;
  ticketNos?: string[];
  boothJobId?: number;
  boothCode?: string;
  workerCode?: string;
}

/* -------------------------------------- Config -------------------------------------- */

// Config storage ของ context แยกตาม async flow (request/job ที่วิ่งพร้อมกันไม่ปนกัน)
const storage = new AsyncLocalStorage<LogContext>();

/* -------------------------------------- Functions -------------------------------------- */

// Function เปิด context ใหม่ให้ request/job แล้วรัน fn ภายใต้ context นั้น
export function runWithLogContext<T>(initial: LogContext, fn: () => T): T {
  return storage.run({ ...initial }, fn);
}

// Function เปิด context ย่อยที่สืบค่าจาก context ปัจจุบัน (ใช้ใน loop หลายรถ/หลายงาน ไม่ให้เลขของรอบก่อนค้าง)
export function runWithChildLogContext<T>(values: LogContext, fn: () => T): T {
  const child = { ...storage.getStore() };

  // เปลี่ยนรถ = เลขตั๋วของรถเดิมไม่เกี่ยวแล้ว
  if (values.ticketJobId !== undefined || values.ticketNumber !== undefined) {
    delete child.ticketJobId;
    delete child.ticketNumber;
    delete child.ticketNo;
    delete child.ticketNos;
    delete child.boothJobId;
    delete child.boothCode;
  }

  return storage.run(child, () => {
    setLogContext(values);
    return fn();
  });
}

// Function เติมข้อมูลอ้างอิงลง context ปัจจุบัน (ไม่มี context = ไม่ทำอะไร, ค่า undefined ไม่ทับของเดิม)
export function setLogContext(values: LogContext): void {
  const context = storage.getStore();

  if (!context) {
    return;
  }

  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) {
      (context as Record<string, unknown>)[key] = value;
    }
  }
}

// Function อ่าน context ปัจจุบัน (object เดิม จึงเห็นค่าที่เติมทีหลัง)
export function getLogContext(): LogContext | undefined {
  return storage.getStore();
}
