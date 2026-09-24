// Import Config
import { VEHICLE_JOB_STATUS, VEHICLE_OPERATION_STATUS } from "../constants/status";
// Import Utils
import { resolveTeamReadinessThreshold } from "./team-requirement";
// Import Types
import type { VehicleOperationStatus } from "../types/admin-jobs.type";

/* -------------------------------------- Types -------------------------------------- */

// Type input แบบ primitive ล้วนสำหรับตัดสิน VehicleOperationStatus — แยกออกจาก Prisma record shape
// เพื่อให้ทั้ง Admin operations board และ Driver ใช้ resolver ตัวเดียวกันได้โดยไม่ต้อง join ข้อมูลชุดเดียวกัน
// (Driver ไม่จำเป็นต้อง join ข้อมูล worker ที่ Admin ใช้)
export interface VehicleOperationStatusInput {
  status: string;
  dispatch_now: boolean;
  workers_required: number;
  // จำนวน Worker ที่ Admin ถอดออกหลัง Scan แล้ว — ไม่นับเป็นช่องที่ขาด สถานะงานรถจึงไม่ถอยกลับไปรอแรงงาน
  removed_after_scan_count: number;
  active_assignment_count: number;
  work_started_at: Date | null;
  has_rejected_booth: boolean;
}

/* -------------------------------------- Functions -------------------------------------- */

// Function ตัดสิน VehicleOperationStatus จาก status, dispatch, จำนวน worker, booth reject และ
// workStartedAt — mutually exclusive ตามลำดับความสำคัญนี้เท่านั้น (เจอก่อนใช้ก่อน) เป็น single source of
// truth ที่ Admin operations board และ Driver ต้องเรียกร่วมกัน ห้ามให้ฝั่งใดคำนวณเองแยกกัน
export function resolveVehicleOperationStatus(
  input: VehicleOperationStatusInput
): VehicleOperationStatus {
  if (input.status === VEHICLE_JOB_STATUS.CANCELLED) {
    return VEHICLE_OPERATION_STATUS.CANCELLED;
  }

  if (input.status === VEHICLE_JOB_STATUS.COMPLETED) {
    return VEHICLE_OPERATION_STATUS.COMPLETED;
  }

  // มีสิทธิ์ก่อน RELEASED เสมอ — เกิดขึ้นได้แม้หลัง release-workers ไปแล้ว (Worker/Admin ส่งยอดใหม่
  // หลัง release แล้ว Vendor reject ซ้ำอีกรอบ) TicketJob.status ยังเป็น RELEASED ค้างอยู่แบบนั้น
  if (input.has_rejected_booth) {
    return VEHICLE_OPERATION_STATUS.REJECT;
  }

  // Format RELEASED ยังนับเป็น working เสมอ (รถยังอยู่ในกระบวนการทำงาน/รอปิดงานแม้แรงงานถูกปล่อยกลับคิวแล้ว)
  if (input.status === VEHICLE_JOB_STATUS.RELEASED) {
    return VEHICLE_OPERATION_STATUS.WORKING;
  }

  // dispatchNow=false ไม่ว่าจะเกิดจาก Gate ตั้งไว้ตอนสร้าง หรือ Admin เปลี่ยนจาก true เป็น false ทีหลัง
  if (!input.dispatch_now) {
    return VEHICLE_OPERATION_STATUS.WAIT_UNLOAD;
  }

  // เทียบกับจำนวนที่ต้องมีจริง (หักคนที่ Admin ถอดออกหลัง Scan แล้ว) ไม่ใช่ workers_required ตั้งต้น
  // ไม่งั้นถอดคนออกจากทีมที่ทำงานอยู่แล้วสถานะจะถอยกลับเป็น wait_worker ทั้งที่ระบบไม่หาคนแทนและทีมยังทำงานต่อได้
  const readinessThreshold = resolveTeamReadinessThreshold(
    input.workers_required,
    input.removed_after_scan_count,
  );

  if (
    readinessThreshold > 0 &&
    input.active_assignment_count < readinessThreshold
  ) {
    return VEHICLE_OPERATION_STATUS.WAIT_WORKER;
  }

  // ทีมครบแล้ว (dispatchNow=true, active>=required) — workStartedAt ถูกตั้งครั้งเดียวตอนทีมทั้งหมด
  // scan เข้างานครบ ใช้แยก "พร้อมแต่ยังไม่เริ่ม" กับ "กำลังทำงานจริง"
  if (input.work_started_at === null) {
    return VEHICLE_OPERATION_STATUS.READY_NOW;
  }

  return VEHICLE_OPERATION_STATUS.WORKING;
}

// Config ค่า OperationStatus ของ Driver Web — subset 6 ค่าตามสเปค (ต่างจาก VEHICLE_OPERATION_STATUS
// ภายในที่มี 7 ค่า เพราะ Driver ไม่แยก reject ออกจาก in-progress)
export const DRIVER_OPERATION_STATUS = {
  WAIT: "WAIT",
  DISPATCH_NOW: "DISPATCH_NOW",
  WAITING_FOR_WORKER: "WAITING_FOR_WORKER",
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
} as const;

export type DriverOperationStatus =
  (typeof DRIVER_OPERATION_STATUS)[keyof typeof DRIVER_OPERATION_STATUS];

// Function แปลง VehicleOperationStatus (ภายใน) เป็น OperationStatus 6 ค่าสำหรับ Driver UI
export function toDriverOperationStatus(
  status: VehicleOperationStatus
): DriverOperationStatus {
  switch (status) {
    case VEHICLE_OPERATION_STATUS.WAIT_UNLOAD:
      return DRIVER_OPERATION_STATUS.WAIT;
    case VEHICLE_OPERATION_STATUS.READY_NOW:
      return DRIVER_OPERATION_STATUS.DISPATCH_NOW;
    case VEHICLE_OPERATION_STATUS.WAIT_WORKER:
      return DRIVER_OPERATION_STATUS.WAITING_FOR_WORKER;
    case VEHICLE_OPERATION_STATUS.WORKING:
    case VEHICLE_OPERATION_STATUS.REJECT:
      return DRIVER_OPERATION_STATUS.IN_PROGRESS;
    case VEHICLE_OPERATION_STATUS.COMPLETED:
      return DRIVER_OPERATION_STATUS.COMPLETED;
    case VEHICLE_OPERATION_STATUS.CANCELLED:
      return DRIVER_OPERATION_STATUS.CANCELLED;
    default:
      return DRIVER_OPERATION_STATUS.IN_PROGRESS;
  }
}
