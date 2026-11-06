// Import Types
import type { AppMiddleware } from "../types/shared/http.type";
// Import Utils
import ApiError from "../utils/api-error";

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจว่า role ของผู้ใช้อยู่ในรายการที่อนุญาต
export default function roleMiddleware(allowedRoles: string[]): AppMiddleware {
  const allowedRoleSet = new Set(allowedRoles);

  return async (c, next) => {
    const auth = c.get("auth");

    if (!auth || !allowedRoleSet.has(auth.role)) {
      throw new ApiError(403, "FORBIDDEN", "Permission denied.");
    }

    await next();
  };
}
