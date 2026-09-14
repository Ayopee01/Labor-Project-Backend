import type { SecurityAuditRequestContext } from "../types/shared/security-audit-log.type";

/* -------------------------------------- Config -------------------------------------- */

// Config ค่า default ของ SecurityAuditRequestContext เมื่อ service ไม่ได้รับ ip/user_agent/request_id มาจาก route
export const EMPTY_SECURITY_AUDIT_CONTEXT: SecurityAuditRequestContext = {
  ip_address: null,
  user_agent: null,
  request_id: null,
};
