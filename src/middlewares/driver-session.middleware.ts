// Import Library
import type { Next } from "hono";
// Import Repositories
import * as driverRepository from "../repositories/driver.repository";
// Import Types
import type { AppContext } from "../types/shared/http.type";
// Import Utils
import { setLogContext } from "../utils/log-context";
import ApiError from "../utils/api-error";
import { extractBearerToken } from "../utils/bearer-token";

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจ Driver session token และ device id (session ช่วง grace period ผ่านแบบอ่านอย่างเดียว)
export default async function driverSessionMiddleware(c: AppContext, next: Next): Promise<void> {
  const token = extractBearerToken(c.req.header("authorization"), {
    missingCode: "MISSING_DRIVER_SESSION",
    missingMessage: "Missing driver session token.",
    invalidCode: "INVALID_DRIVER_SESSION",
    invalidMessage: "Invalid driver session token.",
  });
  const session = await driverRepository.findUsableDriverSessionByToken(token);

  if (!session) {
    throw new ApiError(401, "INVALID_DRIVER_SESSION", "Invalid driver session token.");
  }

  // ทุก session ผูก deviceId ตอนสแกน QR เสมอ — ต้องส่ง header มาตรงกับเครื่องที่สร้าง session ทุก request
  const deviceId = c.req.header("x-driver-device-id");

  if (!deviceId) {
    throw new ApiError(401, "MISSING_DRIVER_DEVICE_ID", "Missing X-Driver-Device-Id header.");
  }

  if (deviceId !== session.device_id) {
    throw new ApiError(401, "DRIVER_DEVICE_MISMATCH", "Device ID does not match the driver session.");
  }

  c.set("driverSession", session);
  setLogContext({ ticketJobId: session.vehicle_job_id, ticketNumber: session.ticket_number });
  await next();
}
