/* -------------------------------------- Types -------------------------------------- */

// Type สิทธิ์ของ admin user แต่ละรายการ
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];

// Type ระดับสิทธิ์ของ admin user
export type AdminPermissionLevel = (typeof ADMIN_PERMISSION_LEVELS)[number];

/* -------------------------------------- Config -------------------------------------- */

// Config รายการสิทธิ์ทั้งหมดที่ admin user มีได้
export const ADMIN_PERMISSIONS = [
  "settings:read",
  "settings:update",
  "roles:read",
  "admins:create",
  "admins:update",
  "admins:reset_password",
  "gate_clients:read",
  "gate_clients:create",
  "gate_clients:update",
  "gate_clients:rotate_secret",
  "permissions:read",
  "permissions:update",
  "workers:read",
  "workers:create",
  "workers:update",
  "workers:reset_password",
  "workers:force_status",
  "jobs:read",
  "jobs:assign",
  "jobs:cancel",
  "jobs:extend_deadline",
  "jobs:override_count",
  "jobs:wait",
  "jobs:release_workers",
  "mobile_app_versions:read",
  "mobile_app_versions:create",
  "mobile_app_versions:update",
  "audit:read",
] as const;

// Config dependencies ของ permission แต่ละรายการ (ถ้า assign permission นี้ ต้องมี permission อื่นด้วย)
export const ADMIN_PERMISSION_DEPENDENCIES: Partial<
  Record<AdminPermission, readonly AdminPermission[]>
> = {
  "mobile_app_versions:create": ["mobile_app_versions:read"],
  "mobile_app_versions:update": ["mobile_app_versions:read"],
};

// Config permission ที่ owner admin user เท่านั้นที่มีได้ (ไม่สามารถ assign ให้ admin คนอื่นได้)
export const OWNER_ONLY_PERMISSIONS: readonly AdminPermission[] = [
  "mobile_app_versions:read",
  "mobile_app_versions:create",
  "mobile_app_versions:update",
  "audit:read",
];

// Config level permission ของ admin เรียงจากสูงไปต่ำ
export const ADMIN_PERMISSION_LEVELS = [
  "owner",
  "manager",
  "supervisor",
] as const;

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจว่า value เป็นชื่อ permission ที่ถูกต้องหรือไม่
export function isAdminPermission(value: string): value is AdminPermission {
  return (ADMIN_PERMISSIONS as readonly string[]).includes(value);
}

// Function ตรวจว่า value เป็นระดับสิทธิ์ admin ที่ถูกต้องหรือไม่
export function isAdminPermissionLevel(
  value?: string | null
): value is AdminPermissionLevel {
  return !!value && (ADMIN_PERMISSION_LEVELS as readonly string[]).includes(value);
}

// Function คืนลำดับของ permission level (ยิ่งน้อยยิ่งสิทธิ์สูง, -1 ถ้าไม่พบ)
export function getPermissionLevelOrder(permissionLevel?: string | null): number {
  return ADMIN_PERMISSION_LEVELS.findIndex((level) => level === permissionLevel);
}

// Function ตรวจว่า actorLevel มีสิทธิ์สูงกว่า targetLevel จนจัดการได้หรือไม่
export function canManagePermissionLevel(
  actorLevel?: string | null,
  targetLevel?: string | null
): boolean {
  const actorOrder = getPermissionLevelOrder(actorLevel);
  const targetOrder = getPermissionLevelOrder(targetLevel);

  return actorOrder >= 0 && targetOrder >= 0 && actorOrder < targetOrder;
}
