// Import Config
import { getDriverActiveDeviceLimit } from "../config/driver.config";
import { withTransaction } from "../db/prisma";
import { TERMINAL_JOB_STATUSES } from "../constants/status";
// Import Repositories
import * as driverRepository from "../repositories/driver.repository";
import * as ticketJobRepository from "../repositories/shared/ticket-job.repository";
// Import Services
import { getRuntimeSettings } from "./shared/runtime-settings.service";
import { closeDriverStreamSession } from "./driver-stream.service";
import { changeTicketJobDispatch } from "./shared/vehicle-dispatch.service";
// Import Types
import type { DriverJobSnapshotResponse, DriverSessionContext, DriverSessionResponse, DriverTicketJobResponse } from "../types/driver.type";
import type { TicketJobDto } from "../types/worker.type";
// Import Validation
import { parseRequiredReference, parseWithSchema } from "../validation/parser";
import { driverJobDispatchBodySchema, driverQrSessionBodySchema } from "../validation/schemas";
// Import Utils
import { formatDriverJobSnapshot } from "../utils/driver-job.formatter";
import ApiError from "../utils/api-error";

/* -------------------------------------- Config -------------------------------------- */

// Config reason_code ที่ระบบใส่ให้ใน audit log เมื่อ Driver เปิด/ปิด dispatch เอง (Driver ไม่ต้องกรอกเหตุผล)
const DRIVER_DISPATCH_REASON_CODE = {
  DISPATCH: "DRIVER_REQUESTED_DISPATCH",
  WAIT: "DRIVER_REQUESTED_WAIT",
} as const;

/* -------------------------------------- Functions -------------------------------------- */

// Function จัดรูปแบบข้อมูลงานรถสำหรับ Driver
function formatDriverTicketJob(
  ticketJob: TicketJobDto,
): DriverTicketJobResponse {
  return {
    ticket_number: ticketJob.ticket_number,
    license_plate: ticketJob.license_plate,
    license_plate_province: ticketJob.license_plate_province,
    vehicle_type: ticketJob.vehicle_type,
    workers_required: ticketJob.workers_required,
    status: ticketJob.status,
    created_at: ticketJob.created_at,
    updated_at: ticketJob.updated_at,
  };
}

// Function โหลด snapshot ปัจจุบันของงานรถสำหรับ Driver
async function loadDriverJobSnapshot(
  ticketJobId: number,
): Promise<DriverJobSnapshotResponse> {
  const record = await driverRepository.getDriverJobSnapshotRecord(ticketJobId);

  if (!record) {
    throw new ApiError(404, "VEHICLE_JOB_NOT_FOUND", "Vehicle job not found.");
  }

  return formatDriverJobSnapshot(record);
}

// Function สร้าง Driver session จาก QR (จำกัดจำนวนเครื่องที่ active ต่องานรถ)
export async function createDriverSessionFromQr(
  body: unknown,
): Promise<DriverSessionResponse> {
  const input = parseWithSchema(driverQrSessionBodySchema, body);
  const ticketJob = await driverRepository.findTicketJobByDriverQrToken(
    input.qr_token,
  );

  if (!ticketJob) {
    throw new ApiError(404, "INVALID_DRIVER_QR", "Driver QR token is invalid.");
  }

  if (TERMINAL_JOB_STATUSES.includes(ticketJob.status)) {
    throw new ApiError(
      409,
      "VEHICLE_JOB_CLOSED",
      "Vehicle job is already closed.",
    );
  }

  const deviceId = input.device_id;
  const deviceLimit = getDriverActiveDeviceLimit();
  const settings = await getRuntimeSettings();
  const driverSessionTtlMs = settings.driver_session_ttl_hours * 60 * 60 * 1000;

  const { session, activeDeviceCount, rotatedSessionId } = await withTransaction(async (transaction) => {
    // Lock แถว TicketJob ก่อนอ่าน/นับ active session กันหลายเครื่องสแกน QR เดียวกันพร้อมกันแล้วทะลุ limit
    const lockedTicketJob = await driverRepository.lockTicketJobForDriverSession(
      ticketJob.id,
      transaction,
    );

    if (!lockedTicketJob || TERMINAL_JOB_STATUSES.includes(lockedTicketJob.status)) {
      throw new ApiError(
        409,
        "VEHICLE_JOB_CLOSED",
        "Vehicle job is already closed.",
      );
    }

    const activeSlots = await driverRepository.listActiveDriverSessionSlots(
      ticketJob.id,
      transaction,
    );

    const existingSameDeviceSlot = activeSlots.find((slot) => slot.device_id === deviceId);
    const distinctDeviceCount = new Set(activeSlots.map((slot) => slot.device_id)).size;

    if (existingSameDeviceSlot) {
      // Device เดิมสแกนซ้ำ — rotate session เก่าทิ้ง ไม่กิน slot เพิ่ม
      await driverRepository.revokeDriverSessionById(existingSameDeviceSlot.id, transaction);
    } else if (distinctDeviceCount >= deviceLimit) {
      throw new ApiError(
        409,
        "DRIVER_SESSION_LIMIT_EXCEEDED",
        "Vehicle job already has the maximum number of active driver devices.",
      );
    }

    const expiresAt = new Date(Date.now() + driverSessionTtlMs);
    const createdSession = await driverRepository.createDriverSession(
      ticketJob.id,
      deviceId,
      expiresAt,
      transaction,
    );

    const nextActiveDeviceCount = existingSameDeviceSlot
      ? distinctDeviceCount
      : distinctDeviceCount + 1;

    return {
      session: createdSession,
      activeDeviceCount: nextActiveDeviceCount,
      rotatedSessionId: existingSameDeviceSlot?.id ?? null,
    };
  });

  // เครื่องเดิมสแกนซ้ำ ต้องปิด SSE ของ session เก่าทันที
  if (rotatedSessionId !== null) {
    closeDriverStreamSession(ticketJob.id, rotatedSessionId);
  }

  return {
    driver_session_token: session.session_token,
    expires_in: driverSessionTtlMs / 1000,
    expires_at: session.expires_at,
    vehicle_job: formatDriverTicketJob(ticketJob),
    active_device_count: activeDeviceCount,
    active_device_limit: deviceLimit,
  };
}

// Function ดึงงานรถปัจจุบันของ Driver session
export async function getDriverCurrentJob(
  session?: DriverSessionContext,
): Promise<DriverJobSnapshotResponse> {
  if (!session) {
    throw new ApiError(
      401,
      "MISSING_DRIVER_SESSION",
      "Missing driver session.",
    );
  }

  return loadDriverJobSnapshot(session.vehicle_job_id);
}

// Function ให้ Driver เปิด/ปิด dispatch ของงานรถ (ปิด = คืนทีมเข้าหน้าคิว) ทำได้เฉพาะก่อนมีแผงส่งยอด
export async function changeDriverJobDispatch(
  idParam: unknown,
  body: unknown,
  session?: DriverSessionContext,
): Promise<DriverJobSnapshotResponse> {
  if (!session) {
    throw new ApiError(
      401,
      "MISSING_DRIVER_SESSION",
      "Missing driver session.",
    );
  }

  if (session.is_read_only) {
    // Session อยู่ใน terminal grace period — อ่านได้อย่างเดียว ห้าม mutate
    throw new ApiError(409, "VEHICLE_JOB_CLOSED", "Vehicle job is already closed.");
  }

  const ticketNumber = parseRequiredReference(idParam, "INVALID_VEHICLE_JOB_REF", "Vehicle job ref is invalid.");
  const input = parseWithSchema(driverJobDispatchBodySchema, body);
  const ticketJob = await ticketJobRepository.findTicketJobByRef(ticketNumber);

  if (!ticketJob) {
    throw new ApiError(404, "VEHICLE_JOB_NOT_FOUND", "Vehicle job not found.");
  }

  if (session.vehicle_job_id !== ticketJob.id) {
    throw new ApiError(
      403,
      "DRIVER_JOB_FORBIDDEN",
      "Driver session cannot access this job.",
    );
  }

  await changeTicketJobDispatch({
    ticket_job: ticketJob,
    dispatch: input.dispatch,
    actor: { type: "driver", driver_session_id: session.id },
    reason_code: input.dispatch
      ? DRIVER_DISPATCH_REASON_CODE.DISPATCH
      : DRIVER_DISPATCH_REASON_CODE.WAIT,
    reason_text: null,
  });

  // คืน snapshot รูปเดียวกับ GET /jobs/current
  return loadDriverJobSnapshot(ticketJob.id);
}

// Function เปิด SSE stream ให้ Driver รับข้อมูลงานรถ (re-export จาก driver-stream.service)
export { subscribeDriverJobStream } from "./driver-stream.service";
