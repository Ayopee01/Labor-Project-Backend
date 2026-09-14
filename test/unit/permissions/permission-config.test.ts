import assert from "node:assert/strict";
import { test } from "node:test";

import { ADMIN_PERMISSIONS, OWNER_ONLY_PERMISSIONS, canManagePermissionLevel, getPermissionLevelOrder, isAdminPermission, isAdminPermissionLevel } from "../../../src/config/permission.config";

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

  // แทนที่จะ import prisma/seed.ts ตรงๆ (เป็น script ที่รัน DB upsert ตอน import) ทดสอบ contract
  // เดียวกับที่ seed.ts ใช้จริง: owner = ADMIN_PERMISSIONS ทั้งหมด, manager/supervisor = ตัดกลุ่ม
  // OWNER_ONLY_PERMISSIONS ออก (มี exception เดียวคือ mobile_app_versions:read ที่ manager ยังได้ ซึ่ง
  // ไม่เกี่ยวกับ audit:read)
  const ownerPermissions = [...ADMIN_PERMISSIONS];
  const nonOwnerPermissions = ADMIN_PERMISSIONS.filter(
    (permission) => !OWNER_ONLY_PERMISSIONS.includes(permission)
  );

  assert.equal(ownerPermissions.includes("audit:read"), true);
  assert.equal(nonOwnerPermissions.includes("audit:read"), false);
});

test("permission config recognizes supported admin permission levels", () => {
  assert.equal(isAdminPermissionLevel("owner"), true);
  assert.equal(isAdminPermissionLevel("manager"), true);
  assert.equal(isAdminPermissionLevel("supervisor"), true);
  assert.equal(isAdminPermissionLevel("worker"), false);
  assert.equal(isAdminPermissionLevel(null), false);
});
