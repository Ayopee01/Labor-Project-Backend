// Import Config
import { ACTIVE_ASSIGNMENT_STATUSES, TICKET_STATUS, VEHICLE_JOB_STATUS } from "../constants/status";
// Import Utils
import { resolveVehicleOperationStatus, toDriverOperationStatus } from "./vehicle-operation-status";
// Import Repositories (type-only — ไม่เรียก function จริง แค่ยืม return type กันนิยาม Prisma include shape ซ้ำ)
import type { getDriverJobSnapshotRecord } from "../repositories/driver.repository";
// Import Types
import type { DriverJobSnapshotResponse } from "../types/driver.type";

/* -------------------------------------- Types -------------------------------------- */

export type DriverJobSnapshotRecord = NonNullable<
  Awaited<ReturnType<typeof getDriverJobSnapshotRecord>>
>;

/* -------------------------------------- Functions -------------------------------------- */

// Function แปลง Date เป็น ISO string โดยรองรับค่า null
function toIsoString(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

// Function หาเวลาปิดงานจาก server ตามสถานะ — ห้ามใช้เวลาปัจจุบันของ request (ดู 38.4 ข้อ 5)
function resolveEndedAt(record: DriverJobSnapshotRecord): string | null {
  if (record.status === VEHICLE_JOB_STATUS.COMPLETED) {
    return toIsoString(record.completedAt);
  }

  if (record.status === VEHICLE_JOB_STATUS.CANCELLED) {
    // TicketJob ไม่มีคอลัมน์ cancelledAt แยก — updatedAt คือเวลาที่ status ถูกเปลี่ยนเป็น CANCELLED ล่าสุด
    // (แนวเดียวกับ buildOperationTiming ในบอร์ด Admin operations ที่ใช้ updatedAt แทนเวลาปิดงานของ CANCELLED)
    return toIsoString(record.updatedAt);
  }

  return null;
}

// Function แปลง vehicle job snapshot record จาก DB เป็น response สำหรับ Driver (REST และ SSE ใช้ร่วมกัน)
export function formatDriverJobSnapshot(
  record: DriverJobSnapshotRecord
): DriverJobSnapshotResponse {
  const activeAssignmentCount = record.assignments.filter((assignment) =>
    (ACTIVE_ASSIGNMENT_STATUSES as string[]).includes(assignment.status)
  ).length;
  const hasRejectedBooth = record.marketJobs.some((market) =>
    market.tickets.some((ticket) => ticket.status === TICKET_STATUS.REJECT)
  );

  const operationStatus = toDriverOperationStatus(
    resolveVehicleOperationStatus({
      status: record.status,
      dispatch_now: record.dispatchNow,
      workers_required: record.workersRequired,
      active_assignment_count: activeAssignmentCount,
      work_started_at: record.workStartedAt,
      has_rejected_booth: hasRejectedBooth,
    })
  );

  return {
    operation_status: operationStatus,
    vehicle_job: {
      ticket_number: record.ticketNumber,
      license_plate: record.licensePlate,
      license_plate_province: record.licensePlateProvince,
      vehicle_type: record.vehicleType,
      workers_required: record.workersRequired,
      status: record.status,
      work_started_at: toIsoString(record.workStartedAt),
      completed_at: toIsoString(record.completedAt),
      ended_at: resolveEndedAt(record),
      created_at: record.createdAt.toISOString(),
      updated_at: record.updatedAt.toISOString(),
    },
    markets: record.marketJobs.map((market) => ({
      ticket_no: market.ticketNo,
      ticket_created_at: market.ticketCreatedAt.toISOString(),
      marketCode: market.marketCode,
      marketName: market.marketName,
      dropoff_point: market.dropoffPoint,
      status: market.status,
      booth_count: market.boothCount,
      booths: market.tickets.map((ticket) => ({
        boothCode: ticket.boothCode,
        boothName: ticket.boothName,
        status: ticket.status,
        confirmation_status: ticket.status,
        products: ticket.products.map((product) => ({
          productCode: product.productCode,
          productName: product.productName,
          packageCode: product.packageCode,
          packageName: product.packageName,
          quantity: product.quantity.toString(),
        })),
      })),
    })),
  };
}
