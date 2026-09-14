// Import Types
import type { TicketJobOperationRecord } from "../types/admin-jobs.type";
import type { AdminTicketJobOperationItemResponse, AdminTicketJobOperationMarketResponse, AdminTicketJobOperationMarketSummaryResponse, AdminTicketJobOperationSummaryResponse, AdminTicketJobOperationWorkerSummaryResponse, VehicleOperationStatus} from "../types/admin-jobs.type";

// Import Config
import { ACTIVE_ASSIGNMENT_STATUSES, ASSIGNMENT_STATUS, SCANNED_ASSIGNMENT_STATUSES, TICKET_STATUS, VEHICLE_JOB_STATUS, VEHICLE_OPERATION_STATUS } from "../constants/status";

// Import Utils
import { findActiveWorkSchedule, formatScheduleWithShift } from "../utils/shift";
import { WORKER_WORK_STATUS } from "../types/shared/worker-status.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function แปลง Date เป็น ISO string โดยรองรับค่า null
function toIsoString(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

// Function แปลงสถานะ assignment เป็นสถานะ worker สำหรับบอร์ด operation
function toOperationWorkerStatus(assignmentStatus: string): string {
  if (
    ([ASSIGNMENT_STATUS.PENDING, ASSIGNMENT_STATUS.ACCEPTED] as string[]).includes(
      assignmentStatus
    )
  ) {
    return WORKER_WORK_STATUS.ASSIGNED;
  }

  if (
    ([
      ASSIGNMENT_STATUS.SCANNED,
      ASSIGNMENT_STATUS.WORKING,
      ASSIGNMENT_STATUS.DELIVERED,
      ASSIGNMENT_STATUS.REJECT,
      ASSIGNMENT_STATUS.COMPLETED,
    ] as string[]).includes(assignmentStatus)
  ) {
    return WORKER_WORK_STATUS.WORKING;
  }

  // Format RELEASED เป็น label เฉพาะบอร์ด operation
  if (assignmentStatus === ASSIGNMENT_STATUS.RELEASED) {
    return "released";
  }

  return WORKER_WORK_STATUS.OPEN_APP;
}

// Function หา label กะของ worker จากข้อมูล schedule ที่เก็บบน account
function resolveOperationWorkerShiftName(
  worker: TicketJobOperationRecord["assignments"][number]["worker"]
): string | null {
  if (
    worker.timeWork === null ||
    worker.timeIn === null ||
    worker.timeOut === null
  ) {
    return null;
  }

  const scheduleDto = {
    id: worker.id,
    worker_id: worker.id,
    time_work: worker.timeWork,
    work_date: (worker.workStartDate ?? worker.createdAt).toISOString().slice(0, 10),
    time_in: worker.timeIn,
    time_out: worker.timeOut,
    is_current: true,
    created_by: null,
    updated_by: null,
    created_at: worker.createdAt.toISOString(),
    updated_at: worker.updatedAt.toISOString(),
  };
  const activeSchedule = findActiveWorkSchedule([scheduleDto]) ?? scheduleDto;

  return formatScheduleWithShift(activeSchedule)?.shift_name ?? null;
}

// Function ตรวจว่า ticket อยู่สถานะ REJECT หรือไม่
function isTicketRejected(
  ticket: TicketJobOperationRecord["marketJobs"][number]["tickets"][number]
): boolean {
  return ticket.status === TICKET_STATUS.REJECT;
}

// Function ตรวจว่า ticket ส่งยอดแล้วและรอ vendor หรือไม่
function isTicketDelivered(
  ticket: TicketJobOperationRecord["marketJobs"][number]["tickets"][number]
): boolean {
  return ticket.status === TICKET_STATUS.DELIVERED;
}

// Function ตรวจว่า ticket จบสมบูรณ์แล้วหรือไม่
function isTicketCompleted(
  ticket: TicketJobOperationRecord["marketJobs"][number]["tickets"][number]
): boolean {
  return ticket.status === TICKET_STATUS.COMPLETED;
}

// Function รวม ticket ทุกตลาดของงานรถเดียวกันเป็น list เดียว
function listOperationTickets(
  record: TicketJobOperationRecord
): TicketJobOperationRecord["marketJobs"][number]["tickets"] {
  return record.marketJobs.flatMap((market) => market.tickets);
}

// Function สรุปจำนวน worker ตามสถานะ assignment ของงานรถหนึ่งงาน
function buildOperationWorkerSummary(
  record: TicketJobOperationRecord
): AdminTicketJobOperationWorkerSummaryResponse {
  const summary: AdminTicketJobOperationWorkerSummaryResponse = {
    required: record.workersRequired,
    assigned: 0,
    active: 0,
    accepted: 0,
    scanned: 0,
    working: 0,
    delivered: 0,
    rejected: 0,
    completed: 0,
    cancelled: 0,
    timeout: 0,
    missing: 0,
  };

  for (const assignment of record.assignments) {
    if (
      !([ASSIGNMENT_STATUS.CANCELLED, ASSIGNMENT_STATUS.TIMEOUT] as string[]).includes(
        assignment.status
      )
    ) {
      summary.assigned += 1;
    }

    if (ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status)) {
      summary.active += 1;
    }

    if (assignment.status === ASSIGNMENT_STATUS.ACCEPTED) {
      summary.accepted += 1;
    }

    if (
      assignment.scannedAt ||
      SCANNED_ASSIGNMENT_STATUSES.includes(assignment.status)
    ) {
      summary.scanned += 1;
    }

    if (assignment.status === ASSIGNMENT_STATUS.WORKING) {
      summary.working += 1;
    } else if (assignment.status === ASSIGNMENT_STATUS.DELIVERED) {
      summary.delivered += 1;
    } else if (assignment.status === ASSIGNMENT_STATUS.REJECT) {
      summary.rejected += 1;
    } else if (assignment.status === ASSIGNMENT_STATUS.COMPLETED) {
      summary.completed += 1;
    } else if (assignment.status === ASSIGNMENT_STATUS.CANCELLED) {
      summary.cancelled += 1;
    } else if (assignment.status === ASSIGNMENT_STATUS.TIMEOUT) {
      summary.timeout += 1;
    }
  }

  summary.missing = Math.max(
    0,
    record.workersRequired - Math.max(summary.active, summary.assigned)
  );

  return summary;
}

// Function สรุปจำนวนตลาด แผง สินค้า และผลยืนยันของงานรถหนึ่งงาน
function buildOperationMarketSummary(
  record: TicketJobOperationRecord
): AdminTicketJobOperationMarketSummaryResponse {
  const tickets = listOperationTickets(record);

  return {
    total: record.marketJobs.length,
    stalls: tickets.length,
    products: tickets.reduce((total, ticket) => total + ticket.products.length, 0),
    delivered: tickets.filter(isTicketDelivered).length,
    confirmed: tickets.filter(isTicketCompleted).length,
    rejected: tickets.filter(isTicketRejected).length,
  };
}

// Function ตัดสิน operation_status สำหรับ UI จัดการรถจาก status, dispatch, จำนวน worker, booth
// reject และ workStartedAt — mutually exclusive ตามลำดับความสำคัญนี้เท่านั้น (เจอก่อนใช้ก่อน)
function resolveVehicleOperationStatus(
  record: TicketJobOperationRecord,
  workerSummary: AdminTicketJobOperationWorkerSummaryResponse,
  rejectedBoothCount: number
): VehicleOperationStatus {
  if (record.status === VEHICLE_JOB_STATUS.CANCELLED) {
    return VEHICLE_OPERATION_STATUS.CANCELLED;
  }

  if (record.status === VEHICLE_JOB_STATUS.COMPLETED) {
    return VEHICLE_OPERATION_STATUS.COMPLETED;
  }

  // มีสิทธิ์ก่อน RELEASED เสมอ — เกิดขึ้นได้แม้หลัง release-workers ไปแล้ว (Worker/Admin ส่งยอดใหม่
  // หลัง release แล้ว Vendor reject ซ้ำอีกรอบ) TicketJob.status ยังเป็น RELEASED ค้างอยู่แบบนั้น
  if (rejectedBoothCount > 0) {
    return VEHICLE_OPERATION_STATUS.REJECT;
  }

  // Format RELEASED ยังนับเป็น working บนบอร์ด operation
  if (record.status === VEHICLE_JOB_STATUS.RELEASED) {
    return VEHICLE_OPERATION_STATUS.WORKING;
  }

  // dispatchNow=false ไม่ว่าจะเกิดจาก Gate ตั้งไว้ตอนสร้าง หรือ Admin เปลี่ยนจาก true เป็น false ทีหลัง
  if (!record.dispatchNow) {
    return VEHICLE_OPERATION_STATUS.WAIT_UNLOAD;
  }

  if (
    record.workersRequired > 0 &&
    workerSummary.active < record.workersRequired
  ) {
    return VEHICLE_OPERATION_STATUS.WAIT_WORKER;
  }

  // ทีมครบแล้ว (dispatchNow=true, active>=required) — workStartedAt ถูกตั้งครั้งเดียวตอนทีมทั้งหมด
  // scan เข้างานครบ (ดู markTicketJobInProgress) ใช้แยก "พร้อมแต่ยังไม่เริ่ม" กับ "กำลังทำงานจริง"
  if (record.workStartedAt === null) {
    return VEHICLE_OPERATION_STATUS.READY_NOW;
  }

  return VEHICLE_OPERATION_STATUS.WORKING;
}

// Function คำนวณเวลาผ่าน Gate และเวลาทำงานของรถ
function buildOperationTiming(record: TicketJobOperationRecord): {
  gate_elapsed_seconds: number;
  working_elapsed_seconds: number | null;
} {
  const now = Date.now();
  const endTime =
    record.status === VEHICLE_JOB_STATUS.COMPLETED ||
    record.status === VEHICLE_JOB_STATUS.CANCELLED
      ? record.updatedAt.getTime()
      : now;
  const scannedTimes = record.assignments
    .map((assignment) => assignment.scannedAt?.getTime())
    .filter((value): value is number => typeof value === "number");
  const firstScannedAt = scannedTimes.length > 0 ? Math.min(...scannedTimes) : null;
  const ticketCreatedTimes = record.marketJobs.map((market) =>
    market.ticketCreatedAt.getTime()
  );
  const earliestTicketCreatedAt =
    ticketCreatedTimes.length > 0
      ? Math.min(...ticketCreatedTimes)
      : record.createdAt.getTime();

  return {
    gate_elapsed_seconds: Math.max(
      0,
      Math.floor((endTime - earliestTicketCreatedAt) / 1000)
    ),
    working_elapsed_seconds:
      firstScannedAt === null
        ? null
        : Math.max(0, Math.floor((endTime - firstScannedAt) / 1000)),
  };
}

// Function แปลงตลาด/แผง/สินค้าเป็น response สำหรับรายละเอียด operation
function formatOperationMarkets(
  record: TicketJobOperationRecord
): AdminTicketJobOperationMarketResponse[] {
  return record.marketJobs.map((market) => {
    const tickets = market.tickets.map((ticket) => ({
      boothCode: ticket.boothCode,
      boothName: ticket.boothName,
      vendor_line_id: ticket.vendorLineId,
      reject_reason: ticket.rejectReason,
      status: ticket.status,
      confirmation_status: ticket.status,
      created_at: ticket.createdAt.toISOString(),
      updated_at: ticket.updatedAt.toISOString(),
      product_count: ticket.products.length,
      products: ticket.products.map((product) => ({
        productCode: product.productCode,
        productName: product.productName,
        packageCode: product.packageCode,
        packageName: product.packageName,
        quantity: product.quantity.toString(),
        confirmed_quantity: product.confirmedQuantity?.toString() ?? null,
      })),
    }));

    return {
      ticket_no: market.ticketNo,
      marketCode: market.marketCode,
      marketName: market.marketName,
      dropoff_point: market.dropoffPoint,
      status: market.status,
      created_at: market.createdAt.toISOString(),
      updated_at: market.updatedAt.toISOString(),
      summary: {
        stalls: tickets.length,
        products: tickets.reduce((total, ticket) => total + ticket.product_count, 0),
        delivered: market.tickets.filter(isTicketDelivered).length,
        confirmed: market.tickets.filter(isTicketCompleted).length,
        rejected: market.tickets.filter(isTicketRejected).length,
      },
      booths: tickets,
    };
  });
}

// Function แปลง record งานรถเป็น item สำหรับหน้า Admin vehicle operations
export function formatVehicleOperationItem(
  record: TicketJobOperationRecord
): AdminTicketJobOperationItemResponse {
  const workerSummary = buildOperationWorkerSummary(record);
  const marketSummary = buildOperationMarketSummary(record);
  const operationStatus = resolveVehicleOperationStatus(
    record,
    workerSummary,
    marketSummary.rejected
  );

  return {
    operation_status: operationStatus,
    vehicle_job: {
      ticket_number: record.ticketNumber,
      plate_no: record.licensePlate,
      plate_province: record.licensePlateProvince,
      vehicle_type: record.vehicleType,
      workers_required: record.workersRequired,
      dispatch_now: record.dispatchNow,
      status: record.status,
      created_at: record.createdAt.toISOString(),
      updated_at: record.updatedAt.toISOString(),
    },
    worker_summary: workerSummary,
    market_summary: marketSummary,
    scan_summary: {
      required: record.workersRequired,
      scanned: workerSummary.scanned,
      remaining: Math.max(0, record.workersRequired - workerSummary.scanned),
    },
    timing: buildOperationTiming(record),
    workers: record.assignments.map((assignment) => ({
      worker_code: assignment.worker.laborCode,
      full_name: assignment.worker.fullName ?? assignment.worker.laborCode,
      labor_color: assignment.worker.laborColor ?? null,
      shirt_number: assignment.worker.coatNo ?? null,
      image_url: assignment.worker.imageUrl,
      shift_name: resolveOperationWorkerShiftName(assignment.worker),
      assignment_status: assignment.status,
      worker_status: toOperationWorkerStatus(assignment.status),
      accept_deadline_at: toIsoString(assignment.acceptDeadlineAt),
      scan_deadline_at: toIsoString(assignment.scanDeadlineAt),
      accepted_at: toIsoString(assignment.acceptedAt),
      scanned_at: toIsoString(assignment.scannedAt),
      completed_at: toIsoString(assignment.completedAt),
      released_at: toIsoString(assignment.releasedAt),
      created_at: assignment.createdAt.toISOString(),
      updated_at: assignment.updatedAt.toISOString(),
    })),
    markets: formatOperationMarkets(record),
  };
}

// Function สรุปจำนวนงานรถแยกตาม operation_status
export function buildVehicleOperationSummary(
  items: AdminTicketJobOperationItemResponse[]
): AdminTicketJobOperationSummaryResponse {
  return items.reduce(
    (summary, item) => {
      summary.total += 1;
      summary[item.operation_status] += 1;
      return summary;
    },
    {
      total: 0,
      ready_now: 0,
      wait_unload: 0,
      wait_worker: 0,
      working: 0,
      completed: 0,
      cancelled: 0,
      reject: 0,
    }
  );
}
