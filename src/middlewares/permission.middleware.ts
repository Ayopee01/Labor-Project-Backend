// Import Config
import type { AdminPermission } from "../config/permission.config";
// Import Types
import type { AppMiddleware } from "../types/shared/http.type";
// Import Utils
import ApiError from "../utils/api-error";

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจว่า Admin มีสิทธิ์ที่ route ต้องการ
export default function permissionMiddleware(requiredPermissions: AdminPermission[]): AppMiddleware {
  return async (c, next) => {
    const permissions = c.get("auth")?.permissions ?? [];
    const hasPermission = requiredPermissions.every((permission) => permissions.includes(permission));

    if (!hasPermission) {
      throw new ApiError(403, "FORBIDDEN", "Permission denied.");
    }

    await next();
  };
}
