
// Import Library
import type { NextFunction, Request, Response } from "express";
// Import Repositories
import * as driverRepository from "../repositories/driver.repository";
// Import Utils
import ApiError from "../utils/api-error";
import { extractBearerToken } from "../utils/bearer-token";

/* -------------------------------------- Functions -------------------------------------- */

// Function จัดการ driver session middleware สำหรับ Express middleware — ตรวจทั้ง session token และ
// X-Driver-Device-Id ที่ต้องตรงกับ deviceId ของ session เสมอ ตาม 38.5 ข้อ 9 session ที่ revoke แล้วแต่ยังอยู่
// ใน terminal grace period จะผ่านมาถึง route handler ได้เช่นกัน (is_read_only=true) ให้ route ที่ mutate ปฏิเสธเอง
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
