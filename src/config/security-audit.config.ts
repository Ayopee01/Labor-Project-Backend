// Import Types
import type { SecurityAuditRequestContext } from "../types/shared/security-audit-log.type";

/* -------------------------------------- Config -------------------------------------- */

// Config ค่า default ของ SecurityAuditRequestContext เมื่อไม่มีข้อมูล request จาก route
export const EMPTY_SECURITY_AUDIT_CONTEXT: SecurityAuditRequestContext = {
  ip_address: null,
  user_agent: null,
  request_id: null,
};
