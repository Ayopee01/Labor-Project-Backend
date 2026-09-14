// Import Library
import type { NextFunction, Request, RequestHandler, Response } from "express";
// Import Dependencies
import ApiError from "../utils/api-error";

/* -------------------------------------- Functions -------------------------------------- */

// Function จัดการ role middleware สำหรับ Express middleware
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
