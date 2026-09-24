// Import Types
import type { Request } from "express";
import type { SecurityAuditRequestContext } from "../types/shared/security-audit-log.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function ดึงบริบทของ request (IP, User-Agent, requestId) สำหรับบันทึก SecurityAuditLog — ใช้ร่วมกันทุก route
export function buildSecurityAuditContext(req: Request): SecurityAuditRequestContext {
  return {
    ip_address: req.ip ?? null,
    user_agent: req.header("user-agent") ?? null,
    request_id: req.requestId ?? null,
  };
}
