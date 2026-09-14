
// Import Library
import type { NextFunction, Request, Response } from "express";
// Import Repositories
import * as driverRepository from "../repositories/driver.repository";
// Import Utils
import ApiError from "../utils/api-error";
import { extractBearerToken } from "../utils/bearer-token";

/* -------------------------------------- Functions -------------------------------------- */

// Function จัดการ driver session middleware สำหรับ Express middleware
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
    const session = await driverRepository.findActiveDriverSessionByToken(token);

    if (!session) {
      throw new ApiError(401, "INVALID_DRIVER_SESSION", "Invalid driver session token.");
    }

    req.driverSession = session;
    next();
  } catch (error) {
    next(error);
  }
}
