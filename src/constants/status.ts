/* -------------------------------------- Config -------------------------------------- */

// Config Status ของ Assignment (Worker-Job)
export const ASSIGNMENT_STATUS = {
  PENDING: "PENDING",
  ACCEPTED: "ACCEPTED",
  SCANNED: "SCANNED",
  WORKING: "WORKING",
  DELIVERED: "DELIVERED",
  REJECT: "REJECT",
  COMPLETED: "COMPLETED",
  RELEASED: "RELEASED",
  CANCELLED: "CANCELLED",
  TIMEOUT: "TIMEOUT",
} as const;

// Config Status ของ Vehicle Job (Ticket) 
export const VEHICLE_JOB_STATUS = {
  WAIT: "WAIT",
  WORKING: "WORKING",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
  RELEASED: "RELEASED",
} as const;

// Config Status ของ Vehicle Operation (Ticket + Booth)
export const VEHICLE_OPERATION_STATUS = {
  CANCELLED: "cancelled",
  COMPLETED: "completed",
  REJECT: "reject",
  WAIT_UNLOAD: "wait_unload",
  WAIT_WORKER: "wait_worker",
  READY_NOW: "ready_now",
  WORKING: "working",
} as const;

// Config Status ของ Daily Worker Income Payment (Ticket + Booth + Worker)
export const DAILY_WORKER_INCOME_PAYMENT_STATUS = {
  SUCCESS: "success",
  PARTIALLY_PAID: "partially_paid",
  CANCEL: "cancel",
  ADMIN_REJECT: "admin_reject",
  WORKER_REJECT: "worker_reject",
} as const;

// Config Snapshot สีเสื้อที่มีอยู่ใน DB MasterWorker.laborColor 
export const SHIRT_COLOR_SNAPSHOT = {
  MIXED: "MIXED",
  UNKNOWN: "UNKNOWN",
} as const;

// Config Status ของ ticket/booth สำหรับ flow ส่งยอดและ vendor ยืนยัน
export const TICKET_STATUS = {
  WAIT: "WAIT",
  WORKING: "WORKING",
  DELIVERED: "DELIVERED",
  REJECT: "REJECT",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
} as const;

// Config Role ใน Ticket/Booth สำหรับ flow ส่งยอดและ vendor ยืนยัน
export const TICKET_SUBMITTER_ROLE = {
  WORKER: "worker",
  ADMIN: "admin",
} as const;

// Config Status ของ membership ของ Worker ภายใน Ticket/Booth
export const TICKET_WORKER_STATUS = {
  WORKING: "WORKING", // Worker คนนี้ยังเป็นสมาชิกของ Booth และมีสิทธิ์ถูกนำไปคิดค่าแรง
  CANCELLED: "CANCELLED", // ถูกถอดออกก่อน Booth Complete จึงไม่มีสิทธิ์ได้เงิน Booth นี้
  COMPLETED: "COMPLETED", // เป็นสมาชิกที่ทำ Booth นี้เสร็จแล้ว และจะถูกใช้เป็นประวัติการจ่ายเงิน
} as const;

// Config Status ของ assignment ที่ยังล็อก worker ไว้กับงานรถ
export const ACTIVE_ASSIGNMENT_STATUSES: string[] = [
  ASSIGNMENT_STATUS.PENDING,
  ASSIGNMENT_STATUS.ACCEPTED,
  ASSIGNMENT_STATUS.SCANNED,
  ASSIGNMENT_STATUS.WORKING,
  ASSIGNMENT_STATUS.DELIVERED,
  ASSIGNMENT_STATUS.REJECT,
];

// Config Status ของ assignment ที่หมายถึง worker กำลังทำงานหรือรอผลส่งยอด
export const WORKING_ASSIGNMENT_STATUSES: string[] = [
  ASSIGNMENT_STATUS.SCANNED,
  ASSIGNMENT_STATUS.WORKING,
  ASSIGNMENT_STATUS.DELIVERED,
  ASSIGNMENT_STATUS.REJECT,
];

// Config Status ของ assignment ที่นับว่า scan QR แล้วสำหรับเช็คความพร้อมของรถ — ต้องรวม RELEASED เสมอ
export const SCANNED_ASSIGNMENT_STATUSES: string[] = [
  ASSIGNMENT_STATUS.SCANNED,
  ASSIGNMENT_STATUS.WORKING,
  ASSIGNMENT_STATUS.DELIVERED,
  ASSIGNMENT_STATUS.REJECT,
  ASSIGNMENT_STATUS.COMPLETED,
  ASSIGNMENT_STATUS.RELEASED,
];

// Config Status ของ assignment ที่นับว่า worker กด Accept แล้ว 
export const ACCEPTED_ASSIGNMENT_STATUSES: string[] = [
  ASSIGNMENT_STATUS.ACCEPTED,
  ASSIGNMENT_STATUS.SCANNED,
  ASSIGNMENT_STATUS.WORKING,
  ASSIGNMENT_STATUS.DELIVERED,
  ASSIGNMENT_STATUS.REJECT,
  ASSIGNMENT_STATUS.COMPLETED,
  ASSIGNMENT_STATUS.RELEASED,
];

// Config Status ของ assignment ที่ยังเก็บไว้ในหน้าจบงานและประวัติหลัง dispatch สิ้นสุด
export const FINISHED_ASSIGNMENT_STATUSES: string[] = [
  ASSIGNMENT_STATUS.PENDING,
  ASSIGNMENT_STATUS.ACCEPTED,
  ASSIGNMENT_STATUS.SCANNED,
  ASSIGNMENT_STATUS.WORKING,
  ASSIGNMENT_STATUS.DELIVERED,
  ASSIGNMENT_STATUS.REJECT,
  ASSIGNMENT_STATUS.COMPLETED,
  ASSIGNMENT_STATUS.RELEASED,
];

// Config Status ของ assignment ที่ Admin release worker
export const RELEASABLE_ASSIGNMENT_STATUSES: string[] = [
  ASSIGNMENT_STATUS.SCANNED,
  ASSIGNMENT_STATUS.WORKING,
  ASSIGNMENT_STATUS.DELIVERED,
];

// Config Status ของ ticket ที่ทำให้ booth ไม่ถูกเลือกเป็นงานเปิดอยู่
export const TERMINAL_TICKET_STATUSES: string[] = [
  TICKET_STATUS.COMPLETED,
  TICKET_STATUS.CANCELLED,
];

// Config Status ของ ticket ที่ส่งยอดให้ vendor แล้ว 
export const SUBMITTED_TICKET_STATUSES: string[] = [
  TICKET_STATUS.DELIVERED,
  TICKET_STATUS.COMPLETED,
  TICKET_STATUS.CANCELLED,
];

// Config Status ของ Vehicle Job (Ticket) สำหรับ Check ว่ารถคันนี้งานเสร็จแล้วหรือยัง
export const TERMINAL_JOB_STATUSES: string[] = [
  VEHICLE_JOB_STATUS.COMPLETED,
  VEHICLE_JOB_STATUS.CANCELLED,
];

// Config Status ของ Vehicle Operation (Ticket + Booth)
export const MASTER_MARKET_ACTIVE_STATUS = "Normal";

// Config Status ของ Booth
export const MASTER_OWNER_STALL_ACTIVE_STATUS = "active";
