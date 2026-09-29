// Import Types
import type { Request } from "express";
import type { SecurityAuditRequestContext } from "../types/shared/security-audit-log.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function ดึง IP, User-Agent และ requestId ของ request สำหรับบันทึก SecurityAuditLog
export function buildSecurityAuditContext(req: Request): SecurityAuditRequestContext {
  return {
    ip_address: req.ip ?? null,
    user_agent: req.header("user-agent") ?? null,
    request_id: req.requestId ?? null,
  };
}
