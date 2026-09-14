/* -------------------------------------- Types -------------------------------------- */

// Type สำหรับ Key ของ Runtime Setting แต่ละรายการ
export type RuntimeSettingKey = (typeof RUNTIME_SETTING_KEYS)[number];
// Type สำหรับค่าของ Runtime Setting แต่ละรายการ
export type RuntimeSettings = Record<RuntimeSettingKey, number>;

/* -------------------------------------- Config -------------------------------------- */

// Config สำหรับ Runtime Setting — อ่านค่าจาก env
export const RUNTIME_SETTING_KEYS = [
  "driver_session_ttl_hours",
  "worker_accept_deadline_seconds",
  "worker_accept_timeout_limit",
  "worker_scan_deadline_minutes",
  "worker_scan_warning_before_minutes",
  "worker_scan_team_remaining_minutes",
  "worker_break_duration_minutes",
  "worker_break_limit",
  "worker_break_count_ttl_hours",
  "worker_presence_stale_seconds",
  "vendor_confirm_timeout_hours",
  "vendor_reconfirm_timeout_hours",
] as const;


