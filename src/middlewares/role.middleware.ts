// Import Library
import type { NextFunction, Request, RequestHandler, Response } from "express";
// Import Utils
import ApiError from "../utils/api-error";

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจว่า role ของผู้ใช้อยู่ในรายการที่อนุญาต
export default function roleMiddleware(allowedRoles: string[]): RequestHandler {
  const allowedRoleSet = new Set(allowedRoles);

  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth || !allowedRoleSet.has(req.auth.role)) {
      next(new ApiError(403, "FORBIDDEN", "Permission denied."));
      return;
    }

    next();
  };
}
