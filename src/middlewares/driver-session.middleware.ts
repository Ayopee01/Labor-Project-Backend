// Import Library
import type { NextFunction, Request, Response } from "express";
// Import Repositories
import * as driverRepository from "../repositories/driver.repository";
// Import Utils
import ApiError from "../utils/api-error";
import { extractBearerToken } from "../utils/bearer-token";

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจ Driver session token และ device id (session ช่วง grace period ผ่านแบบอ่านอย่างเดียว)
export default async function driverSessionMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const token = extractBearerToken(req.header("authorization"), {
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
    const deviceId = req.header("x-driver-device-id");

    if (!deviceId) {
      throw new ApiError(
        401,
        "MISSING_DRIVER_DEVICE_ID",
        "Missing X-Driver-Device-Id header."
      );
    }

    if (deviceId !== session.device_id) {
      throw new ApiError(
        401,
        "DRIVER_DEVICE_MISMATCH",
        "Device ID does not match the driver session."
      );
    }

    req.driverSession = session;
    next();
  } catch (error) {
    next(error);
  }
}
