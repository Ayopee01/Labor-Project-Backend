export const SECURITY_AUDIT_EVENT_TYPE = {
  AUTH_LOGIN_SUCCEEDED: "auth_login_succeeded",
  AUTH_LOGIN_FAILED: "auth_login_failed",
  AUTH_LOGOUT: "auth_logout",
  AUTH_FORCE_LOGIN: "auth_force_login",
  AUTH_SESSION_REVOKED: "auth_session_revoked",
  ACCOUNT_PASSWORD_CHANGED: "account_password_changed",
  ACCOUNT_PASSWORD_RESET: "account_password_reset",
  ADMIN_ACCOUNT_CREATED: "admin_account_created",
  ADMIN_ACCOUNT_UPDATED: "admin_account_updated",
  ADMIN_PERMISSIONS_CHANGED: "admin_permissions_changed",
  ADMIN_STATUS_CHANGED: "admin_status_changed",
  WORKER_ACCOUNT_CREATED: "worker_account_created",
  WORKER_ACCOUNT_UPDATED: "worker_account_updated",
  SYSTEM_SETTINGS_UPDATED: "system_settings_updated",
  GATE_CLIENT_CREATED: "gate_client_created",
  GATE_CLIENT_UPDATED: "gate_client_updated",
  GATE_CLIENT_SECRET_ROTATED: "gate_client_secret_rotated",
  MOBILE_APP_VERSION_CREATED: "mobile_app_version_created",
  MOBILE_APP_VERSION_UPDATED: "mobile_app_version_updated",
  ADMIN_PROFILE_UPDATED: "admin_profile_updated",
} as const;

export type SecurityAuditEventType =
  (typeof SECURITY_AUDIT_EVENT_TYPE)[keyof typeof SECURITY_AUDIT_EVENT_TYPE];

export const SECURITY_AUDIT_OUTCOME = {
  SUCCESS: "success",
  FAILURE: "failure",
} as const;

export type SecurityAuditOutcome =
  (typeof SECURITY_AUDIT_OUTCOME)[keyof typeof SECURITY_AUDIT_OUTCOME];

export type SecurityAuditActorType = "admin" | "worker";

export interface SecurityAuditRequestContext {
  ip_address: string | null;
  user_agent: string | null;
  request_id: string | null;
}

export interface SecurityAuditLogWriteInput {
  event_type: SecurityAuditEventType;
  outcome: SecurityAuditOutcome;
  actor_type?: SecurityAuditActorType | null;
  actor_account_id?: number | null;
  actor_worker_id?: number | null;
  actor_username?: string | null;
  actor_full_name?: string | null;
  session_id?: number | null;
  request_id?: string | null;
  ip_address?: string | null;
  user_agent?: string | null;
  failure_code?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface SecurityAuditLogDto {
  id: number;
  event_type: string;
  outcome: string;
  actor_type: string | null;
  actor_account_id: number | null;
  actor_worker_id: number | null;
  actor_username: string | null;
  actor_full_name: string | null;
  session_id: number | null;
  request_id: string | null;
  ip_address: string | null;
  user_agent: string | null;
  failure_code: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}
