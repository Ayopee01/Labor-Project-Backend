// Import Config
import { VEHICLE_JOB_STATUS, VEHICLE_OPERATION_STATUS } from "../constants/status";
// Import Utils
import { resolveTeamReadinessThreshold } from "./team-requirement";
// Import Types
import type { VehicleOperationStatus } from "../types/admin-jobs.type";

/* -------------------------------------- Types -------------------------------------- */

// Type input สำหรับตัดสิน VehicleOperationStatus (ใช้ร่วมกันทั้ง Admin และ Driver)
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

// Function ตัดสิน VehicleOperationStatus ตามลำดับความสำคัญ (Admin และ Driver ต้องใช้ตัวนี้ร่วมกัน)
export function resolveVehicleOperationStatus(
  input: VehicleOperationStatusInput
): VehicleOperationStatus {
  if (input.status === VEHICLE_JOB_STATUS.CANCELLED) {
    return VEHICLE_OPERATION_STATUS.CANCELLED;
  }

  if (input.status === VEHICLE_JOB_STATUS.COMPLETED) {
    return VEHICLE_OPERATION_STATUS.COMPLETED;
  }

  // เช็คก่อน RELEASED เพราะแผงอาจถูกตีกลับหลัง release ได้
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

  // เทียบกับจำนวนที่ต้องมีจริง (หักคนที่ถูกถอดหลัง scan) ไม่ใช่ workers_required ตั้งต้น
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

  // ทีมครบแล้ว ใช้ workStartedAt แยก "พร้อมแต่ยังไม่เริ่ม" กับ "กำลังทำงานจริง"
  if (input.work_started_at === null) {
    return VEHICLE_OPERATION_STATUS.READY_NOW;
  }

  return VEHICLE_OPERATION_STATUS.WORKING;
}

// Config OperationStatus 6 ค่าของ Driver Web (ไม่แยก reject ออกจาก in-progress)
export const DRIVER_OPERATION_STATUS = {
  WAIT: "WAIT",
  DISPATCH_NOW: "DISPATCH_NOW",
  WAITING_FOR_WORKER: "WAITING_FOR_WORKER",
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
} as const;

// Type OperationStatus ของ Driver Web
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
