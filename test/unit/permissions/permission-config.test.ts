// Import Library
import assert from "node:assert/strict";
import { test } from "node:test";
// Import Config
import { ADMIN_PERMISSIONS, OWNER_ONLY_PERMISSIONS, canManagePermissionLevel, getPermissionLevelOrder, isAdminPermission } from "../../../src/config/permission.config";

/* -------------------------------------- Permission Config Tests -------------------------------------- */

test("permission config recognizes supported admin permissions and rejects unknown values", () => {
  assert.equal(isAdminPermission("workers:read"), true);
  assert.equal(isAdminPermission("gate_clients:rotate_secret"), true);
  assert.equal(isAdminPermission("permissions:update"), true);
  assert.equal(isAdminPermission("unknown:permission"), false);
});

test("permission config orders admin levels from highest to lowest rank", () => {
  assert.equal(getPermissionLevelOrder("owner"), 0);
  assert.equal(getPermissionLevelOrder("manager"), 1);
  assert.equal(getPermissionLevelOrder("supervisor"), 2);
  assert.equal(getPermissionLevelOrder("unknown"), -1);
});

test("permission config only allows higher rank admin to manage lower rank admin", () => {
  assert.equal(canManagePermissionLevel("owner", "manager"), true);
  assert.equal(canManagePermissionLevel("owner", "supervisor"), true);
  assert.equal(canManagePermissionLevel("manager", "supervisor"), true);
  assert.equal(canManagePermissionLevel("manager", "manager"), false);
  assert.equal(canManagePermissionLevel("manager", "owner"), false);
  assert.equal(canManagePermissionLevel("supervisor", "manager"), false);
});

test("audit:read is owner-only, so prisma/seed.ts's role permission templates (owner = all ADMIN_PERMISSIONS, manager/supervisor = ADMIN_PERMISSIONS minus OWNER_ONLY_PERMISSIONS) grant it to owner by default and withhold it from manager/supervisor (27.12 item 7 — default per permission level)", () => {
  assert.equal(OWNER_ONLY_PERMISSIONS.includes("audit:read"), true);

  // จำลองสิทธิ์ตาม seed.ts: owner ได้ทั้งหมด manager/supervisor ตัด OWNER_ONLY_PERMISSIONS
  const ownerPermissions = [...ADMIN_PERMISSIONS];
  const nonOwnerPermissions = ADMIN_PERMISSIONS.filter(
    (permission) => !OWNER_ONLY_PERMISSIONS.includes(permission)
  );

  assert.equal(ownerPermissions.includes("audit:read"), true);
  assert.equal(nonOwnerPermissions.includes("audit:read"), false);
});
