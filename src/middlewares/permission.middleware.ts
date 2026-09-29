// Import Library
import type { NextFunction, Request, RequestHandler, Response } from "express";
// Import Config
import type { AdminPermission } from "../config/permission.config";
// Import Utils
import ApiError from "../utils/api-error";

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจว่า Admin มีสิทธิ์ที่ route ต้องการ
export default function permissionMiddleware(
  requiredPermissions: AdminPermission[]
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const permissions = req.auth?.permissions ?? [];
    const hasPermission = requiredPermissions.every((permission) =>
      permissions.includes(permission)
    );

    if (!hasPermission) {
      next(new ApiError(403, "FORBIDDEN", "Permission denied."));
      return;
    }

    next();
  };
}
