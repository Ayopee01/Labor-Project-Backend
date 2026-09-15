// Import Config
import { withTransaction } from "../db/prisma";
import { TERMINAL_TICKET_STATUSES, VEHICLE_JOB_STATUS } from "../constants/status";
// Import Repositories
import * as driverRepository from "../repositories/driver.repository";
import * as ticketJobRepository from "../repositories/shared/ticket-job.repository";
// Import Queues
import { dispatchReadyWorkers } from "../queues/worker-dispatch";
// Import Services
import { getRuntimeSettings } from "./shared/runtime-settings.service";
import { publishNotification } from "./notifications.service";
import { notifyVendorBoothDispatchResumed } from "./shared/vendor-line-notification.service";
// Import Types
import type { DriverJobReadyResponse, DriverSessionDto, DriverSessionResponse, DriverTicketJobDetailResponse, DriverTicketJobResponse } from "../types/driver.type";
import type { TicketJobDetailResponse, TicketJobDto } from "../types/worker.type";
// Import Validation
import { parseWithSchema } from "../validation/parser";
import { driverQrSessionBodySchema } from "../validation/schemas";
// Import Utils
import ApiError from "../utils/api-error";
import { logger } from "../utils/logger";

/* -------------------------------------- Functions -------------------------------------- */

// Function อ่านค่า reference ใน service flow
function parseReference(value: unknown): string {
  const reference = String(value ?? "").trim();

  if (!reference) {
    throw new ApiError(
      400,
      "INVALID_VEHICLE_JOB_REF",
      "Vehicle job ref is invalid.",
    );
  }

  return reference;
}

// Function จัดรูปแบบ driver vehicle job ใน service flow
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

// Function จัดรูปแบบ driver vehicle job detail ใน service flow
function formatDriverTicketJobDetail(
  detail: TicketJobDetailResponse,
): DriverTicketJobDetailResponse {
  return {
    vehicle_job: formatDriverTicketJob(detail.vehicle_job),
    markets: detail.markets.map((market) => ({
      ticket_no: market.ticket_no,
      boothCount: market.booth_count,
      marketCode: market.marketCode,
      marketName: market.marketName,
      status: market.status,
      booths: market.booths.map((ticket) => ({
        boothCode: ticket.boothCode,
        boothName: ticket.boothName,
        status: ticket.status,
        confirmation_status: ticket.confirmation_status,
        products: ticket.products.map((product) => ({
          productCode: product.productCode,
          productName: product.productName,
          packageCode: product.packageCode,
          packageName: product.packageName,
          quantity: product.quantity,
        })),
      })),
    })),
  };
}

// Function สร้าง driver session จาก QR ใน service flow
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

  if (
    ticketJob.status === VEHICLE_JOB_STATUS.COMPLETED ||
    ticketJob.status === VEHICLE_JOB_STATUS.CANCELLED
  ) {
    throw new ApiError(
      409,
      "VEHICLE_JOB_CLOSED",
      "Vehicle job is already closed.",
    );
  }

  const settings = await getRuntimeSettings();
  const driverSessionTtlMs = settings.driver_session_ttl_hours * 60 * 60 * 1000;
  const expiresAt = new Date(Date.now() + driverSessionTtlMs);
  const session = await driverRepository.createDriverSession(
    ticketJob.id,
    expiresAt,
  );

  return {
    driver_session_token: session.session_token,
    expires_in: driverSessionTtlMs / 1000,
    expires_at: session.expires_at,
    vehicle_job: formatDriverTicketJob(ticketJob),
  };
}

// Function ดึง driver current job ใน service flow
export async function getDriverCurrentJob(
  session?: DriverSessionDto,
): Promise<DriverTicketJobDetailResponse> {
  if (!session) {
    throw new ApiError(
      401,
      "MISSING_DRIVER_SESSION",
      "Missing driver session.",
    );
  }

  const detail = await ticketJobRepository.getTicketJobDetail(
    session.vehicle_job_id,
  );

  if (!detail) {
    throw new ApiError(404, "VEHICLE_JOB_NOT_FOUND", "Vehicle job not found.");
  }

  return formatDriverTicketJobDetail(detail);
}

// Function อัปเดตสถานะ driver job ready ใน service flow
export async function markDriverJobReady(
  idParam: unknown,
  session?: DriverSessionDto,
): Promise<DriverJobReadyResponse> {
  if (!session) {
    throw new ApiError(
      401,
      "MISSING_DRIVER_SESSION",
      "Missing driver session.",
    );
  }

  const ticketNumber = parseReference(idParam);
  const requestedTicketJob =
    await ticketJobRepository.findTicketJobByRef(ticketNumber);

  if (!requestedTicketJob) {
    throw new ApiError(404, "VEHICLE_JOB_NOT_FOUND", "Vehicle job not found.");
  }

  if (session.vehicle_job_id !== requestedTicketJob.id) {
    throw new ApiError(
      403,
      "DRIVER_JOB_FORBIDDEN",
      "Driver session cannot access this job.",
    );
  }

  const ticketJobId = await withTransaction(async (transaction) => {
    const ticketJob = await ticketJobRepository.findTicketJobByRef(
      ticketNumber,
      transaction,
    );

    if (!ticketJob) {
      throw new ApiError(
        404,
        "VEHICLE_JOB_NOT_FOUND",
        "Vehicle job not found.",
      );
    }

    if (ticketJob.status !== VEHICLE_JOB_STATUS.WAIT) {
      // ยอมให้ mark ready เฉพาะตอนสถานะ WAIT เท่านั้น กันงานที่ release-workers ปล่อยทีมกลับคิวไปแล้ว
      // ถูกดึงกลับมาเรียก dispatch ซ้ำผ่านทางนี้
      throw new ApiError(
        409,
        "VEHICLE_JOB_NOT_READY",
        "Vehicle job cannot be marked ready.",
      );
    }

    await driverRepository.markTicketJobReady(ticketJob.id, transaction);

    return ticketJob.id;
  });

  // เรียก dispatchReadyWorkers แยกหลัง transaction ข้างบน commit แล้วเท่านั้น เพราะ dispatch เขียนทั้ง
  // DB และ Redis/BullMQ — ถ้าอยู่ใน transaction เดิมแล้ว rollback ทีหลัง Redis/BullMQ จะไม่ rollback ตาม ทำให้ค้างสถานะผิด
  try {
    await dispatchReadyWorkers(undefined, {
      vehicle_job_ids: [ticketJobId],
    });
  } catch (error) {
    logger.error("Dispatch after driver marked job ready failed.", {
      ticketJobId,
      error,
    });
  }

  const detail = await ticketJobRepository.getTicketJobDetail(ticketJobId);

  if (!detail) {
    throw new ApiError(
      404,
      "VEHICLE_JOB_NOT_FOUND",
      "Vehicle job not found.",
    );
  }

  // แจ้ง LINE แผงว่าทีมงานถูกจัดส่งอีกครั้ง — เหมือนตอน Admin สั่งรถกลับจาก "รอลง" เป็น "ลงเลย" เพราะความหมายเดียวกันคือทีมเริ่มถูกจัดส่งจริง
  for (const market of detail.markets) {
    for (const booth of market.booths) {
      if (TERMINAL_TICKET_STATUSES.includes(booth.status)) {
        continue;
      }

      await notifyVendorBoothDispatchResumed({
        ticketId: booth.id,
        ticketNo: market.ticket_no,
        marketName: market.marketName,
        boothCode: booth.boothCode,
        boothName: booth.boothName,
        licensePlate: detail.vehicle_job.license_plate,
      });
    }
  }

  publishNotification({
    type: "DRIVER_JOB_READY",
    title: "Driver job ready",
    message: `Driver marked vehicle job ${detail.vehicle_job.ticket_number} ready.`,
    payload: {
      ticketNumber: detail.vehicle_job.ticket_number,
      license_plate: detail.vehicle_job.license_plate,
      license_plate_province: detail.vehicle_job.license_plate_province,
      status: detail.vehicle_job.status,
    },
    audience: {
      roles: ["admin"],
    },
  });

  return {
    ticket_number: detail.vehicle_job.ticket_number,
    license_plate: detail.vehicle_job.license_plate,
    license_plate_province: detail.vehicle_job.license_plate_province,
    status: detail.vehicle_job.status,
  };
}
