// Import Types
import type { AppContext } from "../types/shared/http.type";
import type { SecurityAuditRequestContext } from "../types/shared/security-audit-log.type";
// Import Utils
import { getClientIp } from "./http";

/* -------------------------------------- Functions -------------------------------------- */

// Function ดึง IP, User-Agent และ requestId ของ request สำหรับบันทึก SecurityAuditLog
export function buildSecurityAuditContext(c: AppContext): SecurityAuditRequestContext {
  return {
    ip_address: getClientIp(c) ?? null,
    user_agent: c.req.header("user-agent") ?? null,
    request_id: c.get("requestId") ?? null,
  };
}
