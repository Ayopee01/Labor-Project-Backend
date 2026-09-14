import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { addAdmin, addGateClient, addMobileAppVersion, getPassword, getWorkerDispatch, resetRouteTestState, restoreRouteTestLoader, startRouteTestServer, state, type TestServer } from "../helpers/app-test-harness";

let server: TestServer;
let password: typeof import("../../src/utils/password");
let workerDispatch: typeof import("../../src/queues/worker-dispatch");

/* -------------------------------------- Test Lifecycle -------------------------------------- */

before(async () => {
  password = await getPassword();
  workerDispatch = await getWorkerDispatch();
  server = await startRouteTestServer();
});

beforeEach(() => {
  resetRouteTestState();
});

after(async () => {
  await server.close();
  restoreRouteTestLoader();
});

/* -------------------------------------- Admin Settings Route Tests -------------------------------------- */

// Function จัดการ login admin สำหรับ test
async function loginAdmin(accountId: number, permissionLevel: string) {
  const passwordHash = await password.hashPassword("Admin@123456");
  const admin = addAdmin(accountId, passwordHash);
  admin.permission_level = permissionLevel;
  state.adminPermissions.set(admin.id, [
    "admins:create",
    "admins:update",
    "admins:reset_password",
    "gate_clients:read",
    "gate_clients:create",
    "gate_clients:update",
    "gate_clients:rotate_secret",
    "permissions:read",
    "permissions:update",
    "roles:read",
    "workers:read",
    "workers:create",
    "settings:read",
    "settings:update",
    "mobile_app_versions:read",
    "mobile_app_versions:create",
    "mobile_app_versions:update",
  ]);

  const login = await server.request("POST", "/api/auth/login", {
    body: {
      username: admin.username,
      password: "Admin@123456",
    },
  });

  assert.equal(login.status, 200);

  return {
    token: login.body.access_token,
    admin,
  };
}

test("POST /api/admin/admins allows owner to create lower level admin", async () => {
  const { token } = await loginAdmin(9101, "owner");

  const response = await server.request("POST", "/api/admin/admins", {
    token,
    body: {
      username: "manager01",
      password: "Manager@123456",
      full_name: "Branch Manager",
      position: "Manager",
      email: "manager01@simmummuang.local",
      phone: "081-000-0002",
      permission_level: "manager",
      permissions: ["workers:read", "workers:create"],
    },
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.message, "Admin account created successfully.");
  assert.equal(response.body.account.role, "admin");
  assert.equal(response.body.account.username, "manager01");
  assert.equal(response.body.account.email, "manager01@simmummuang.local");
  assert.equal(response.body.account.phone, "081-000-0002");
  assert.equal(response.body.account.password_hash, undefined);
  assert.equal(response.body.permission_level, "manager");
  assert.deepEqual(response.body.permissions, ["workers:read", "workers:create"]);
});

test("POST /api/admin/admins rejects creating equal level admin", async () => {
  const { token } = await loginAdmin(9102, "manager");

  const response = await server.request("POST", "/api/admin/admins", {
    token,
    body: {
      username: "manager02",
      password: "Manager@123456",
      full_name: "Another Manager",
      permission_level: "manager",
      permissions: ["workers:read"],
    },
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.code, "NEW_PERMISSION_LEVEL_NOT_MANAGEABLE");
});

test("POST /api/admin/admins rejects granting a permission the actor does not have (privilege escalation)", async () => {
  const passwordHash = await password.hashPassword("Admin@123456");
  const owner = addAdmin(9105, passwordHash);
  owner.permission_level = "owner";
  state.adminPermissions.set(owner.id, ["admins:create"]);

  const login = await server.request("POST", "/api/auth/login", {
    body: { username: owner.username, password: "Admin@123456" },
  });

  const response = await server.request("POST", "/api/admin/admins", {
    token: login.body.access_token,
    body: {
      username: "manager03",
      password: "Manager@123456",
      full_name: "Escalated Manager",
      permission_level: "manager",
      permissions: ["settings:update"],
    },
  });

  assert.equal(response.status, 403);
  assert.equal(response.body.code, "PERMISSIONS_NOT_GRANTABLE");
  assert.equal(state.authAccountsByUsername.has("manager03"), false);
});

test("PATCH /api/admin/users/:id/permissions rejects granting a permission the actor does not have (privilege escalation)", async () => {
  const passwordHash = await password.hashPassword("Admin@123456");
  const owner = addAdmin(9106, passwordHash);
  owner.permission_level = "owner";
  state.adminPermissions.set(owner.id, ["permissions:update"]);

  const login = await server.request("POST", "/api/auth/login", {
    body: { username: owner.username, password: "Admin@123456" },
  });

  const target = addAdmin(9107, await password.hashPassword("Admin@123456"));
  target.permission_level = "manager";
  state.adminPermissions.set(target.id, []);

  const response = await server.request(
    "PATCH",
    `/api/admin/users/${target.id}/permissions`,
    {
      token: login.body.access_token,
      body: {
        permission_level: "manager",
        permissions: ["gate_clients:rotate_secret"],
      },
    }
  );

  assert.equal(response.status, 403);
  assert.equal(response.body.code, "PERMISSIONS_NOT_GRANTABLE");
  assert.deepEqual(state.adminPermissions.get(target.id), []);
});

test("POST /api/admin/admins rejects granting mobile_app_versions:create without mobile_app_versions:read (dependency)", async () => {
  const passwordHash = await password.hashPassword("Admin@123456");
  const owner = addAdmin(9108, passwordHash);
  owner.permission_level = "owner";
  state.adminPermissions.set(owner.id, [
    "admins:create",
    "mobile_app_versions:read",
    "mobile_app_versions:create",
  ]);

  const login = await server.request("POST", "/api/auth/login", {
    body: { username: owner.username, password: "Admin@123456" },
  });

  const response = await server.request("POST", "/api/admin/admins", {
    token: login.body.access_token,
    body: {
      username: "manager04",
      password: "Manager@123456",
      full_name: "Manager Missing Read",
      permission_level: "manager",
      // create ไม่มี read คู่กัน ต้องโดนปฏิเสธก่อนสร้างบัญชี
      permissions: ["mobile_app_versions:create"],
    },
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.code, "PERMISSION_DEPENDENCY_NOT_SATISFIED");
  assert.equal(state.authAccountsByUsername.has("manager04"), false);
});

test("PATCH /api/admin/users/:id/permissions rejects granting mobile_app_versions:update without mobile_app_versions:read (dependency)", async () => {
  const passwordHash = await password.hashPassword("Admin@123456");
  const owner = addAdmin(9109, passwordHash);
  owner.permission_level = "owner";
  state.adminPermissions.set(owner.id, [
    "permissions:update",
    "mobile_app_versions:read",
    "mobile_app_versions:update",
  ]);

  const login = await server.request("POST", "/api/auth/login", {
    body: { username: owner.username, password: "Admin@123456" },
  });

  const target = addAdmin(9110, await password.hashPassword("Admin@123456"));
  target.permission_level = "manager";
  state.adminPermissions.set(target.id, []);

  const response = await server.request(
    "PATCH",
    `/api/admin/users/${target.id}/permissions`,
    {
      token: login.body.access_token,
      body: {
        permission_level: "manager",
        permissions: ["mobile_app_versions:update"],
      },
    }
  );

  assert.equal(response.status, 400);
  assert.equal(response.body.code, "PERMISSION_DEPENDENCY_NOT_SATISFIED");
  assert.deepEqual(state.adminPermissions.get(target.id), []);
});

test("PATCH /api/admin/users/:id/permissions rejects a manager granting mobile_app_versions:read even though the manager already holds it (owner-only group)", async () => {
  const passwordHash = await password.hashPassword("Admin@123456");
  const manager = addAdmin(9111, passwordHash);
  manager.permission_level = "manager";
  state.adminPermissions.set(manager.id, [
    "permissions:update",
    "mobile_app_versions:read",
  ]);

  const login = await server.request("POST", "/api/auth/login", {
    body: { username: manager.username, password: "Admin@123456" },
  });

  const target = addAdmin(9112, await password.hashPassword("Admin@123456"));
  target.permission_level = "supervisor";
  state.adminPermissions.set(target.id, []);

  const response = await server.request(
    "PATCH",
    `/api/admin/users/${target.id}/permissions`,
    {
      token: login.body.access_token,
      body: {
        permission_level: "supervisor",
        permissions: ["mobile_app_versions:read"],
      },
    }
  );

  assert.equal(response.status, 403);
  assert.equal(response.body.code, "OWNER_ONLY_PERMISSIONS");
  assert.deepEqual(state.adminPermissions.get(target.id), []);
});

test("PATCH /api/admin/users/:id/permissions allows an owner to grant mobile_app_versions:read+create to a target", async () => {
  const { token } = await loginAdmin(9113, "owner");

  const target = addAdmin(9114, await password.hashPassword("Admin@123456"));
  target.permission_level = "manager";
  state.adminPermissions.set(target.id, []);

  const response = await server.request(
    "PATCH",
    `/api/admin/users/${target.id}/permissions`,
    {
      token,
      body: {
        permission_level: "manager",
        permissions: ["mobile_app_versions:read", "mobile_app_versions:create"],
      },
    }
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(
    [...state.adminPermissions.get(target.id)!].sort(),
    ["mobile_app_versions:create", "mobile_app_versions:read"],
  );
});

test("PATCH /api/admin/users/:id/permissions allows a manager to update unrelated permissions while resubmitting the target's existing mobile_app_versions:* set unchanged", async () => {
  const passwordHash = await password.hashPassword("Admin@123456");
  const manager = addAdmin(9115, passwordHash);
  manager.permission_level = "manager";
  state.adminPermissions.set(manager.id, [
    "permissions:update",
    "mobile_app_versions:read",
    "workers:read",
  ]);

  const login = await server.request("POST", "/api/auth/login", {
    body: { username: manager.username, password: "Admin@123456" },
  });

  const target = addAdmin(9116, await password.hashPassword("Admin@123456"));
  target.permission_level = "supervisor";
  // target มี mobile_app_versions:read อยู่ก่อนแล้ว (สมมติ owner grant ไว้ก่อนหน้า)
  state.adminPermissions.set(target.id, ["mobile_app_versions:read"]);

  const response = await server.request(
    "PATCH",
    `/api/admin/users/${target.id}/permissions`,
    {
      token: login.body.access_token,
      body: {
        permission_level: "supervisor",
        // เพิ่ม workers:read ให้ target แต่ mobile_app_versions:read เดิมยังอยู่เหมือนเดิม ไม่ได้ถอด
        // หรือเพิ่มอะไรในกลุ่ม owner-only เลย จึงไม่ควรโดนบล็อก แม้ actor เป็น manager
        permissions: ["mobile_app_versions:read", "workers:read"],
      },
    }
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.deepEqual(
    [...state.adminPermissions.get(target.id)!].sort(),
    ["mobile_app_versions:read", "workers:read"],
  );
});

test("POST /api/admin/gate-clients creates a Gate client and shows secret once", async () => {
  const { token, admin } = await loginAdmin(9151, "owner");

  const response = await server.request("POST", "/api/admin/gate-clients", {
    token,
    body: {
      client_id: "gate-north",
      name: "North Gate",
    },
  });
  const listed = await server.request("GET", "/api/admin/gate-clients", {
    token,
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.message.includes("Save client_secret now"), true);
  assert.equal(response.body.client_id, "gate-north");
  assert.equal(response.body.client_secret.startsWith("gate_live_"), true);
  assert.equal(response.body.secret_hash, undefined);
  assert.equal(state.gateClients.get("gate-north")?.created_by, admin.id);
  assert.equal(
    await password.verifyPassword(
      response.body.client_secret,
      state.gateClients.get("gate-north")?.secret_hash
    ),
    true
  );
  assert.equal(listed.status, 200);
  assert.equal(listed.body.data[0].client_id, "gate-north");
  assert.equal(listed.body.data[0].client_secret, undefined);
  assert.equal(listed.body.data[0].secret_hash, undefined);
});

test("PATCH /api/admin/gate-clients/:clientId updates name and status", async () => {
  const { token, admin } = await loginAdmin(9152, "owner");
  addGateClient("gate-south", await password.hashPassword("GateSecret@123456"));

  const response = await server.request("PATCH", "/api/admin/gate-clients/gate-south", {
    token,
    body: {
      name: "South Gate Disabled",
      status: "inactive",
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.client_id, "gate-south");
  assert.equal(response.body.name, "South Gate Disabled");
  assert.equal(response.body.status, "inactive");
  assert.equal(response.body.client_secret, undefined);
  assert.equal(response.body.secret_hash, undefined);
  assert.equal(state.gateClients.get("gate-south")?.updated_by, admin.id);
});

test("POST /api/admin/gate-clients/:clientId/secret/rotate replaces the old secret", async () => {
  const { token } = await loginAdmin(9153, "owner");
  const oldSecret = "GateSecret@123456";
  addGateClient("gate-west", await password.hashPassword(oldSecret));

  const response = await server.request(
    "POST",
    "/api/admin/gate-clients/gate-west/secret/rotate",
    { token }
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.client_id, "gate-west");
  assert.equal(response.body.client_secret.startsWith("gate_live_"), true);
  assert.equal(response.body.client_secret === oldSecret, false);
  assert.equal(response.body.secret_hash, undefined);
  assert.equal(
    await password.verifyPassword(
      oldSecret,
      state.gateClients.get("gate-west")?.secret_hash
    ),
    false
  );
  assert.equal(
    await password.verifyPassword(
      response.body.client_secret,
      state.gateClients.get("gate-west")?.secret_hash
    ),
    true
  );
});

test("GET /api/admin/roles groups admin accounts by permission level", async () => {
  const { token } = await loginAdmin(9201, "owner");
  const manager = addAdmin(9202, await password.hashPassword("Admin@123456"));
  manager.permission_level = "manager";
  const supervisor = addAdmin(9203, await password.hashPassword("Admin@123456"));
  supervisor.permission_level = "supervisor";

  const response = await server.request("GET", "/api/admin/roles", {
    token,
  });

  assert.equal(response.status, 200);
  const managerRole = response.body.data.find((role: { key: string }) => role.key === "manager");
  const supervisorRole = response.body.data.find((role: { key: string }) => role.key === "supervisor");
  assert.ok(managerRole.admins.some((admin: { id: number }) => admin.id === manager.id));
  assert.ok(supervisorRole.admins.some((admin: { id: number }) => admin.id === supervisor.id));
  assert.equal(managerRole.admins[0].password_hash, undefined);
});

test("GET /api/admin/users/:id/permissions allows reading only lower level admins", async () => {
  const { token: ownerToken, admin: owner } = await loginAdmin(9301, "owner");
  const manager = addAdmin(9302, await password.hashPassword("Admin@123456"));
  manager.permission_level = "manager";
  state.adminPermissions.set(manager.id, ["workers:read"]);
  const { token: managerToken } = await loginAdmin(9303, "manager");
  const peerManager = addAdmin(9304, await password.hashPassword("Admin@123456"));
  peerManager.permission_level = "manager";

  const lowerResponse = await server.request(
    "GET",
    `/api/admin/users/${manager.id}/permissions`,
    { token: ownerToken }
  );
  const selfResponse = await server.request(
    "GET",
    `/api/admin/users/${owner.id}/permissions`,
    { token: ownerToken }
  );
  const peerResponse = await server.request(
    "GET",
    `/api/admin/users/${peerManager.id}/permissions`,
    { token: managerToken }
  );

  assert.equal(lowerResponse.status, 200);
  assert.equal(lowerResponse.body.account_id, manager.id);
  assert.equal(lowerResponse.body.status, "active");
  assert.deepEqual(lowerResponse.body.permissions, ["workers:read"]);
  assert.equal(selfResponse.status, 403);
  assert.equal(selfResponse.body.code, "CANNOT_READ_OWN_PERMISSIONS");
  assert.equal(peerResponse.status, 403);
  assert.equal(peerResponse.body.code, "TARGET_PERMISSION_LEVEL_NOT_READABLE");
});

test("PATCH /api/admin/users/:id/permissions updates lower admin status and revokes sessions", async () => {
  const { token: ownerToken } = await loginAdmin(9401, "owner");
  const { token: supervisorToken, admin: supervisor } = await loginAdmin(9402, "supervisor");

  const response = await server.request(
    "PATCH",
    `/api/admin/users/${supervisor.id}/permissions`,
    {
      token: ownerToken,
      body: {
        permission_level: "supervisor",
        status: "inactive",
        permissions: ["workers:read"],
      },
    }
  );
  const targetMeAfterPatch = await server.request("GET", "/api/auth/me", {
    token: supervisorToken,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.status, "inactive");
  assert.equal(state.authAccountsById.get(supervisor.id)?.status, "inactive");
  assert.deepEqual(response.body.permissions, ["workers:read"]);
  assert.equal(targetMeAfterPatch.status, 401);
});

test("PATCH /api/admin/admins/:id updates a lower-level admin's basic info", async () => {
  const { token: ownerToken } = await loginAdmin(9410, "owner");
  const manager = addAdmin(9411, await password.hashPassword("Admin@123456"));
  manager.permission_level = "manager";

  const response = await server.request(
    "PATCH",
    `/api/admin/admins/${manager.id}`,
    {
      token: ownerToken,
      body: {
        full_name: "Updated Manager Name",
        position: "Senior Manager",
        email: "updated-manager@simmummuang.local",
        phone: "081-999-9999",
      },
    }
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.message, "Admin account updated successfully.");
  assert.equal(response.body.account.full_name, "Updated Manager Name");
  assert.equal(response.body.account.position, "Senior Manager");
  assert.equal(response.body.account.email, "updated-manager@simmummuang.local");
  assert.equal(response.body.account.phone, "081-999-9999");
  assert.equal(response.body.account.password_hash, undefined);
  assert.equal(state.authAccountsById.get(manager.id)?.full_name, "Updated Manager Name");
});

test("PATCH /api/admin/admins/:id rejects managing your own account", async () => {
  const { token: ownerToken, admin: owner } = await loginAdmin(9412, "owner");

  const response = await server.request(
    "PATCH",
    `/api/admin/admins/${owner.id}`,
    {
      token: ownerToken,
      body: {
        full_name: "Should not apply",
      },
    }
  );

  assert.equal(response.status, 403);
  assert.equal(response.body.code, "CANNOT_MANAGE_OWN_ACCOUNT");
});

test("PATCH /api/admin/admins/:id rejects managing an equal or higher permission level", async () => {
  const { token: managerToken } = await loginAdmin(9413, "manager");
  const peerManager = addAdmin(9414, await password.hashPassword("Admin@123456"));
  peerManager.permission_level = "manager";

  const response = await server.request(
    "PATCH",
    `/api/admin/admins/${peerManager.id}`,
    {
      token: managerToken,
      body: {
        full_name: "Should not apply",
      },
    }
  );

  assert.equal(response.status, 403);
  assert.equal(response.body.code, "TARGET_PERMISSION_LEVEL_NOT_MANAGEABLE");
  assert.notEqual(state.authAccountsById.get(peerManager.id)?.full_name, "Should not apply");
});

test("PATCH /api/admin/admins/:id/password resets a lower-level admin's password and revokes their sessions", async () => {
  const { token: ownerToken } = await loginAdmin(9415, "owner");
  const { token: managerToken, admin: manager } = await loginAdmin(9416, "manager");

  const response = await server.request(
    "PATCH",
    `/api/admin/admins/${manager.id}/password`,
    {
      token: ownerToken,
      body: {
        new_password: "NewManagerPass@123456",
      },
    }
  );
  const targetMeAfterReset = await server.request("GET", "/api/auth/me", {
    token: managerToken,
  });
  const relogin = await server.request("POST", "/api/auth/login", {
    body: {
      username: manager.username,
      password: "NewManagerPass@123456",
    },
  });

  assert.equal(response.status, 200);
  assert.equal(
    response.body.message,
    "Admin password reset successfully. Active sessions were revoked."
  );
  assert.equal(targetMeAfterReset.status, 401);
  assert.equal(relogin.status, 200);
});

/* -------------------------------------- Mobile App Version Route Tests -------------------------------------- */

// Function หา delayed job release notification ของ Version หนึ่งจาก queue จำลอง สำหรับ test
function findReleaseNotificationJob(mobileAppVersionId: number) {
  const jobs = state.queueJobs.get(process.env.BULLMQ_ASSIGNMENT_TIMEOUT_QUEUE as string);

  return jobs?.get(`mobile-app-release-notification-${mobileAppVersionId}`);
}

// Function หา delayed job force-update notification ของ Version หนึ่งจาก queue จำลอง สำหรับ test
function findForceUpdateNotificationJob(mobileAppVersionId: number) {
  const jobs = state.queueJobs.get(process.env.BULLMQ_ASSIGNMENT_TIMEOUT_QUEUE as string);

  return jobs?.get(`mobile-app-force-update-notification-${mobileAppVersionId}`);
}

// Function จำลองเวลาถึง ReleaseNotificationAt โดยเรียก processor ตรงๆ (แบบเดียวกับ pattern เดิม
// ที่ใช้จำลอง assignment/vendor-confirm timeout ทั่วทั้ง test suite นี้) แทนการรอ BullMQ จริง
async function fireReleaseNotificationJob(mobileAppVersionId: number): Promise<void> {
  workerDispatch.startAssignmentTimeoutProcessing();
  const queueName = process.env.BULLMQ_ASSIGNMENT_TIMEOUT_QUEUE as string;
  const processor = state.workerProcessors.get(queueName);

  assert.ok(processor, "Assignment timeout processor must be registered.");
  await processor({
    data: {
      mobileAppVersionId,
      kind: "mobile_app_release_notification",
    },
  });
}

// Function จำลองเวลาถึง ForceUpdateAt โดยเรียก processor ตรงๆ สำหรับ force-update notification job
async function fireForceUpdateNotificationJob(mobileAppVersionId: number): Promise<void> {
  workerDispatch.startAssignmentTimeoutProcessing();
  const queueName = process.env.BULLMQ_ASSIGNMENT_TIMEOUT_QUEUE as string;
  const processor = state.workerProcessors.get(queueName);

  assert.ok(processor, "Assignment timeout processor must be registered.");
  await processor({
    data: {
      mobileAppVersionId,
      kind: "mobile_app_force_update_notification",
    },
  });
}

test("GET /api/admin/mobile-app-versions requires mobile_app_versions:read (not settings:read)", async () => {
  const passwordHash = await password.hashPassword("Admin@123456");
  const admin = addAdmin(9117, passwordHash);
  admin.permission_level = "owner";
  // มี settings:read แต่ไม่มี mobile_app_versions:read — เส้นนี้ต้องไม่ใช้ settings:read ร่วมกันแล้ว
  state.adminPermissions.set(admin.id, ["settings:read"]);

  const login = await server.request("POST", "/api/auth/login", {
    body: { username: admin.username, password: "Admin@123456" },
  });

  const response = await server.request("GET", "/api/admin/mobile-app-versions", {
    token: login.body.access_token,
  });

  assert.equal(response.status, 403);
});

test("POST /api/admin/mobile-app-versions requires mobile_app_versions:create (not settings:update)", async () => {
  const passwordHash = await password.hashPassword("Admin@123456");
  const admin = addAdmin(9118, passwordHash);
  admin.permission_level = "owner";
  state.adminPermissions.set(admin.id, ["settings:update", "mobile_app_versions:read"]);

  const login = await server.request("POST", "/api/auth/login", {
    body: { username: admin.username, password: "Admin@123456" },
  });

  const response = await server.request("POST", "/api/admin/mobile-app-versions", {
    token: login.body.access_token,
    body: {
      version: "1.4.0",
      build_number: 10400,
      android_download_url: "https://play.google.com/store/apps/details?id=worker",
      ios_download_url: "https://apps.apple.com/app/id123456789",
    },
  });

  assert.equal(response.status, 403);
});

test("PATCH /api/admin/mobile-app-versions/:id requires mobile_app_versions:update (not settings:update)", async () => {
  const passwordHash = await password.hashPassword("Admin@123456");
  const admin = addAdmin(9119, passwordHash);
  admin.permission_level = "owner";
  state.adminPermissions.set(admin.id, ["settings:update", "mobile_app_versions:read"]);

  const login = await server.request("POST", "/api/auth/login", {
    body: { username: admin.username, password: "Admin@123456" },
  });

  const version = addMobileAppVersion({ version: "1.3.0", build_number: 10300 });

  const response = await server.request(
    "PATCH",
    `/api/admin/mobile-app-versions/${version.id}`,
    {
      token: login.body.access_token,
      body: { release_message: "Updated message." },
    }
  );

  assert.equal(response.status, 403);
});

test("GET /api/admin/mobile-app-versions classifies rows into current/scheduled/history by time", async () => {
  const { token } = await loginAdmin(9501, "owner");
  const pastActivation = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const futureActivation = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  addMobileAppVersion({
    version: "1.2.0",
    build_number: 10200,
    force_update_at: pastActivation,
  });
  const current = addMobileAppVersion({
    version: "1.3.0",
    build_number: 10300,
    force_update_at: pastActivation,
  });
  const scheduled = addMobileAppVersion({
    version: "1.4.0",
    build_number: 10400,
    force_update_at: futureActivation,
  });

  const response = await server.request("GET", "/api/admin/mobile-app-versions", {
    token,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.current.id, current.id);
  assert.equal(response.body.current.status, "current");
  assert.equal(response.body.scheduled.id, scheduled.id);
  assert.equal(response.body.scheduled.status, "scheduled");
  assert.equal(response.body.history.length, 1);
  assert.equal(response.body.history[0].version, "1.2.0");
  assert.equal(response.body.history[0].status, "history");
});

test("POST /api/admin/mobile-app-versions creates a scheduled version without affecting the current one", async () => {
  const { token } = await loginAdmin(9502, "owner");

  addMobileAppVersion({ version: "1.3.0", build_number: 10300 });

  // ต้องคำนวณสัมพัทธ์กับเวลาจริงตอนรัน test เสมอ ห้าม hardcode วันที่ตายตัว — classifyMobileAppVersions
  // เทียบกับ new Date() สดๆ ทุกครั้ง (ดู resolveActivationTime) วันที่ตายตัวจะกลายเป็นอดีตเมื่อเวลาผ่านไป
  // ทำให้ version นี้ถูกจัดเป็น "current" แทน "scheduled" โดยไม่ได้ตั้งใจ (regression ที่เจอจริงใน CI)
  const releaseNotificationAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const forceUpdateAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

  const response = await server.request("POST", "/api/admin/mobile-app-versions", {
    token,
    body: {
      version: "1.4.0",
      build_number: 10400,
      android_download_url: "https://play.google.com/store/apps/details?id=worker",
      ios_download_url: "https://apps.apple.com/app/id123456789",
      release_message: "Please update by the deadline.",
      release_notes: "Improved dispatch and notifications.",
      force_update_at: forceUpdateAt.toISOString(),
      release_notification_at: releaseNotificationAt.toISOString(),
    },
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.status, "scheduled");
  assert.equal(response.body.version, "1.4.0");

  const overview = await server.request("GET", "/api/admin/mobile-app-versions", {
    token,
  });

  assert.equal(overview.body.current.version, "1.3.0");
  assert.equal(overview.body.scheduled.version, "1.4.0");
});

test("POST /api/admin/mobile-app-versions rejects a duplicate BuildNumber", async () => {
  const { token } = await loginAdmin(9503, "owner");

  addMobileAppVersion({ version: "1.3.0", build_number: 10300 });

  const response = await server.request("POST", "/api/admin/mobile-app-versions", {
    token,
    body: {
      version: "1.3.1",
      build_number: 10300,
    },
  });

  assert.equal(response.status, 409);
  assert.equal(response.body.code, "BUILD_NUMBER_ALREADY_EXISTS");
});

test("POST /api/admin/mobile-app-versions rejects ReleaseNotificationAt later than ForceUpdateAt", async () => {
  const { token } = await loginAdmin(9508, "owner");

  const response = await server.request("POST", "/api/admin/mobile-app-versions", {
    token,
    body: {
      version: "1.4.0",
      build_number: 10400,
      force_update_at: "2026-08-22T15:00:00.000Z",
      release_notification_at: "2026-08-23T02:00:00.000Z",
    },
  });

  assert.equal(response.status, 400);
});

test("PATCH /api/admin/mobile-app-versions/:id allows changing Version/BuildNumber while still scheduled", async () => {
  const { token } = await loginAdmin(9505, "owner");
  const scheduled = addMobileAppVersion({
    version: "1.4.0",
    build_number: 10400,
    force_update_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });

  const response = await server.request(
    "PATCH",
    `/api/admin/mobile-app-versions/${scheduled.id}`,
    {
      token,
      body: {
        version: "1.4.1",
        build_number: 10401,
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.version, "1.4.1");
  assert.equal(response.body.build_number, 10401);
  assert.equal(response.body.status, "scheduled");
});

test("PATCH /api/admin/mobile-app-versions/:id rejects changing Version/BuildNumber once it is current", async () => {
  const { token } = await loginAdmin(9506, "owner");
  const current = addMobileAppVersion({ version: "1.3.0", build_number: 10300 });

  const response = await server.request(
    "PATCH",
    `/api/admin/mobile-app-versions/${current.id}`,
    {
      token,
      body: {
        version: "1.3.9",
      },
    },
  );

  assert.equal(response.status, 409);
  assert.equal(response.body.code, "MOBILE_APP_VERSION_LOCKED");
});

test("PATCH /api/admin/mobile-app-versions/:id reschedules the ReleaseNotificationAt BullMQ job to the latest time", async () => {
  const { token } = await loginAdmin(9507, "owner");
  const scheduled = addMobileAppVersion({
    version: "1.4.0",
    build_number: 10400,
    force_update_at: "2026-08-25T15:00:00.000Z",
    release_notification_at: "2026-08-24T02:00:00.000Z",
  });

  const response = await server.request(
    "PATCH",
    `/api/admin/mobile-app-versions/${scheduled.id}`,
    {
      token,
      body: {
        // ReleaseNotificationAt is one of two independent timestamps that each have their own
        // attached BullMQ job (release pre-notice vs force-update-now); "current" activation is
        // still derived live from server time on every read/check, never from either job.
        release_notification_at: "2026-08-24T05:00:00.000Z",
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.release_notification_at, "2026-08-24T05:00:00.000Z");
  assert.equal(response.body.release_notification_sent_at, null);

  const job = findReleaseNotificationJob(scheduled.id);

  assert.ok(job);
  assert.equal(job?.data && (job.data as { mobileAppVersionId?: number }).mobileAppVersionId, scheduled.id);
});

test("PATCH /api/admin/mobile-app-versions/:id reschedules the ForceUpdateAt force-update notification job to the latest time", async () => {
  const { token } = await loginAdmin(9514, "owner");
  const scheduled = addMobileAppVersion({
    version: "1.4.0",
    build_number: 10400,
    force_update_at: "2026-08-25T15:00:00.000Z",
  });

  const response = await server.request(
    "PATCH",
    `/api/admin/mobile-app-versions/${scheduled.id}`,
    {
      token,
      body: {
        force_update_at: "2026-08-26T09:00:00.000Z",
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.force_update_at, "2026-08-26T09:00:00.000Z");
  assert.equal(response.body.force_update_notification_sent_at, null);

  const job = findForceUpdateNotificationJob(scheduled.id);

  assert.ok(job);
  assert.equal(job?.data && (job.data as { mobileAppVersionId?: number }).mobileAppVersionId, scheduled.id);
});

test("PATCH /api/admin/mobile-app-versions/:id clearing ForceUpdateAt removes the force-update notification job", async () => {
  const { token } = await loginAdmin(9515, "owner");
  const scheduled = addMobileAppVersion({
    version: "1.4.0",
    build_number: 10400,
    force_update_at: "2026-08-25T15:00:00.000Z",
  });

  const response = await server.request(
    "PATCH",
    `/api/admin/mobile-app-versions/${scheduled.id}`,
    {
      token,
      body: {
        force_update_at: null,
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.force_update_at, null);

  const job = findForceUpdateNotificationJob(scheduled.id);

  assert.ok(!job || job.removed);
});

test("POST /api/admin/mobile-app-versions with ReleaseNotificationAt left null sends the release notification now but does not activate the version", async () => {
  const { token } = await loginAdmin(9509, "owner");

  addMobileAppVersion({ version: "1.3.0", build_number: 10300 });

  const response = await server.request("POST", "/api/admin/mobile-app-versions", {
    token,
    body: {
      version: "1.4.0",
      build_number: 10400,
      force_update_at: "2026-12-25T15:00:00.000Z",
    },
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.release_notification_at, null);
  assert.ok(
    response.body.release_notification_sent_at,
    "release_notification_sent_at must be set immediately.",
  );
  assert.equal(response.body.force_update_notification_sent_at, null);
  assert.equal(findReleaseNotificationJob(response.body.id), undefined);
  assert.ok(findForceUpdateNotificationJob(response.body.id));

  const overview = await server.request("GET", "/api/admin/mobile-app-versions", {
    token,
  });

  // ส่ง Release Notification ทันทีแล้ว แต่ Version ยังไม่ Active เพราะ ForceUpdateAt อยู่ในอนาคต
  assert.equal(overview.body.current.version, "1.3.0");
  assert.equal(overview.body.scheduled.version, "1.4.0");
});

test("POST /api/admin/mobile-app-versions with ReleaseNotificationAt set does not send yet and creates a delayed job", async () => {
  const { token } = await loginAdmin(9510, "owner");
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  const response = await server.request("POST", "/api/admin/mobile-app-versions", {
    token,
    body: {
      version: "1.4.0",
      build_number: 10400,
      release_notification_at: tomorrow,
    },
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.release_notification_sent_at, null);

  const job = findReleaseNotificationJob(response.body.id);

  assert.ok(job);
  assert.equal(job?.removed, false);
});

test("scheduled release notification sends FCM and sets ReleaseNotificationSentAt once ReleaseNotificationAt is reached, without activating the version", async () => {
  const { token } = await loginAdmin(9511, "owner");

  addMobileAppVersion({ version: "1.3.0", build_number: 10300 });
  const scheduled = addMobileAppVersion({
    version: "1.4.0",
    build_number: 10400,
    force_update_at: "2026-12-25T15:00:00.000Z",
    // ต้องเป็นเวลาในอดีตเทียบกับนาฬิกาจริงตอนรัน test เพื่อจำลอง "ถึงเวลาจริงแล้ว" ให้ตรงกับ Guard
    // ใหม่ใน sendMobileAppReleaseNotification ที่เช็ค Date.now() เทียบกับ release_notification_at
    // ล่าสุดใน DB ก่อนส่งจริงเสมอ (กัน Race ที่ Job เก่าถืออัตราเวลาที่ถูกเลื่อนไปแล้ว)
    release_notification_at: "2026-08-01T02:00:00.000Z",
  });

  await fireReleaseNotificationJob(scheduled.id);

  assert.ok(
    scheduled.release_notification_sent_at,
    "release_notification_sent_at must be set after the job fires.",
  );

  const overview = await server.request("GET", "/api/admin/mobile-app-versions", {
    token,
  });

  // FCM ส่งแล้วแต่ Version ยังไม่ Active เพราะยังไม่ถึง ForceUpdateAt
  assert.equal(overview.body.current.version, "1.3.0");
  assert.equal(overview.body.scheduled.version, "1.4.0");

  const check = await server.request(
    "GET",
    "/api/workers/app-version/check?platform=android&version=1.3.0&build_number=10300",
  );

  assert.equal(check.body.status, "UP_TO_DATE");
});

test("force-update notification sends a standard-pattern-only FCM and sets ForceUpdateNotificationSentAt once ForceUpdateAt is reached", async () => {
  const { token } = await loginAdmin(9516, "owner");

  addMobileAppVersion({ version: "1.3.0", build_number: 10300 });
  const scheduled = addMobileAppVersion({
    version: "1.4.0",
    build_number: 10400,
    // ต้องเป็นเวลาในอดีตเทียบกับนาฬิกาจริงตอนรัน test เพื่อจำลอง "ถึงเวลาจริงแล้ว" ให้ตรงกับ Guard
    // ใหม่ใน sendMobileAppForceUpdateNotification (ดูเหตุผลเดียวกับ Release Notification ด้านบน)
    force_update_at: "2026-08-01T15:00:00.000Z",
    release_message: "This should not appear in the force-update notification.",
  });

  await fireForceUpdateNotificationJob(scheduled.id);

  assert.ok(
    scheduled.force_update_notification_sent_at,
    "force_update_notification_sent_at must be set after the job fires.",
  );
  // Release Notification ยังคนละ tracker กัน ยิงคนละครั้งกัน ไม่เกี่ยวกัน
  assert.equal(scheduled.release_notification_sent_at, null);
});

test("PATCH /api/admin/mobile-app-versions/:id setting ReleaseNotificationAt to null removes the job and sends now", async () => {
  const { token } = await loginAdmin(9512, "owner");
  const scheduled = addMobileAppVersion({
    version: "1.4.0",
    build_number: 10400,
    release_notification_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
  });

  const response = await server.request(
    "PATCH",
    `/api/admin/mobile-app-versions/${scheduled.id}`,
    {
      token,
      body: {
        release_notification_at: null,
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.release_notification_at, null);
  assert.ok(response.body.release_notification_sent_at);

  const job = findReleaseNotificationJob(scheduled.id);

  assert.ok(!job || job.removed);
});

test("PATCH /api/admin/mobile-app-versions/:id never resends FCM once ReleaseNotificationSentAt is already set", async () => {
  const { token } = await loginAdmin(9513, "owner");
  const alreadySent = addMobileAppVersion({
    version: "1.4.0",
    build_number: 10400,
    release_notification_sent_at: new Date().toISOString(),
  });
  const sentAtBefore = alreadySent.release_notification_sent_at;

  const response = await server.request(
    "PATCH",
    `/api/admin/mobile-app-versions/${alreadySent.id}`,
    {
      token,
      body: {
        release_message: "Updated release message text.",
        release_notification_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.release_message, "Updated release message text.");
  // ReleaseNotificationSentAt ต้องไม่เปลี่ยน (ไม่ส่งซ้ำ) แม้ Admin จะแก้เวลากลับไปเป็น scheduled
  assert.equal(response.body.release_notification_sent_at, sentAtBefore);
  assert.equal(findReleaseNotificationJob(alreadySent.id), undefined);
});

test("PATCH /api/admin/mobile-app-versions/:id never resends the force-update FCM once ForceUpdateNotificationSentAt is already set", async () => {
  const { token } = await loginAdmin(9517, "owner");
  const alreadySent = addMobileAppVersion({
    version: "1.4.0",
    build_number: 10400,
    force_update_at: "2026-08-25T15:00:00.000Z",
    force_update_notification_sent_at: new Date().toISOString(),
  });
  const sentAtBefore = alreadySent.force_update_notification_sent_at;

  const response = await server.request(
    "PATCH",
    `/api/admin/mobile-app-versions/${alreadySent.id}`,
    {
      token,
      body: {
        force_update_at: "2026-08-26T09:00:00.000Z",
      },
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.force_update_at, "2026-08-26T09:00:00.000Z");
  // ForceUpdateNotificationSentAt ต้องไม่เปลี่ยน (ไม่ส่งซ้ำ) แม้ Admin จะเลื่อนเวลาใหม่
  assert.equal(response.body.force_update_notification_sent_at, sentAtBefore);
  assert.equal(findForceUpdateNotificationJob(alreadySent.id), undefined);
});

/* -------------------------------------- Security Audit Log Tests (27.12 phase 2-4) -------------------------------------- */

test("PATCH /api/admin/settings writes a system_settings_updated SecurityAuditLog with only the changed keys", async () => {
  const { token, admin } = await loginAdmin(9601, "owner");

  const response = await server.request("PATCH", "/api/admin/settings", {
    token,
    body: { worker_break_limit: 5 },
  });

  assert.equal(response.status, 200, JSON.stringify(response.body));

  const log = state.securityAuditLogs.find(
    (item) => item.event_type === "system_settings_updated" && item.actor_account_id === admin.id,
  );

  assert.ok(log);
  assert.equal(log.outcome, "success");
  assert.equal(
    (log.metadata as { after?: { worker_break_limit?: string } } | null)?.after
      ?.worker_break_limit,
    "5",
  );
});

test("Gate client create/update/secret-rotate write gate_client_* SecurityAuditLog events, and the secret rotation event never contains the plaintext secret or its hash", async () => {
  const { token, admin } = await loginAdmin(9611, "owner");

  const created = await server.request("POST", "/api/admin/gate-clients", {
    token,
    body: { client_id: "gate-audit-9611", name: "Audit Gate" },
  });

  assert.equal(created.status, 201, JSON.stringify(created.body));

  const createdLog = state.securityAuditLogs.find(
    (item) => item.event_type === "gate_client_created" && item.actor_account_id === admin.id,
  );

  assert.ok(createdLog);
  assert.equal(
    (createdLog.metadata as { targetClientId?: string } | null)?.targetClientId,
    "gate-audit-9611",
  );

  const updated = await server.request(
    "PATCH",
    "/api/admin/gate-clients/gate-audit-9611",
    { token, body: { name: "Renamed Gate", status: "inactive" } },
  );

  assert.equal(updated.status, 200, JSON.stringify(updated.body));

  const updatedLog = state.securityAuditLogs.find(
    (item) => item.event_type === "gate_client_updated" && item.actor_account_id === admin.id,
  );

  assert.ok(updatedLog);
  assert.equal(
    (updatedLog.metadata as { after?: { name?: string; status?: string } } | null)?.after?.name,
    "Renamed Gate",
  );

  const rotated = await server.request(
    "POST",
    "/api/admin/gate-clients/gate-audit-9611/secret/rotate",
    { token },
  );

  assert.equal(rotated.status, 200, JSON.stringify(rotated.body));

  const rotatedLog = state.securityAuditLogs.find(
    (item) => item.event_type === "gate_client_secret_rotated" && item.actor_account_id === admin.id,
  );

  assert.ok(rotatedLog);
  const rotatedLogJson = JSON.stringify(rotatedLog);

  assert.equal(rotatedLogJson.includes(rotated.body.client_secret), false);
  assert.equal(rotatedLogJson.toLowerCase().includes("secret_hash"), false);
});

test("Admin account create/update/password-reset write admin_account_*/account_password_reset SecurityAuditLog events with only the changed fields", async () => {
  const { token: ownerToken, admin: owner } = await loginAdmin(9621, "owner");

  const created = await server.request("POST", "/api/admin/admins", {
    token: ownerToken,
    body: {
      username: "audited-manager-9621",
      password: "Manager@123456",
      full_name: "Audited Manager",
      permission_level: "manager",
      permissions: ["workers:read"],
    },
  });

  assert.equal(created.status, 201, JSON.stringify(created.body));

  const createdLog = state.securityAuditLogs.find(
    (item) => item.event_type === "admin_account_created" && item.actor_account_id === owner.id,
  );

  assert.ok(createdLog);
  assert.equal(
    (createdLog.metadata as { targetUsername?: string } | null)?.targetUsername,
    "audited-manager-9621",
  );

  const targetId = created.body.account.id;

  const updated = await server.request("PATCH", `/api/admin/admins/${targetId}`, {
    token: ownerToken,
    body: { full_name: "Renamed Manager" },
  });

  assert.equal(updated.status, 200, JSON.stringify(updated.body));

  const updatedLog = state.securityAuditLogs.find(
    (item) => item.event_type === "admin_account_updated" && item.actor_account_id === owner.id,
  );

  assert.ok(updatedLog);
  assert.equal(
    (updatedLog.metadata as { before?: { full_name?: string } } | null)?.before?.full_name,
    "Audited Manager",
  );
  assert.equal(
    (updatedLog.metadata as { after?: { full_name?: string } } | null)?.after?.full_name,
    "Renamed Manager",
  );

  const resetPassword = await server.request(
    "PATCH",
    `/api/admin/admins/${targetId}/password`,
    { token: ownerToken, body: { new_password: "NewManager@123456" } },
  );

  assert.equal(resetPassword.status, 200, JSON.stringify(resetPassword.body));

  const resetLog = state.securityAuditLogs.find(
    (item) => item.event_type === "account_password_reset" && item.actor_account_id === owner.id,
  );

  assert.ok(resetLog);
  assert.equal(
    (resetLog.metadata as { targetAccountId?: number } | null)?.targetAccountId,
    targetId,
  );
});

test("PATCH /api/admin/users/:id/permissions writes both admin_permissions_changed and admin_status_changed SecurityAuditLog events when both actually change", async () => {
  const { token: ownerToken, admin: owner } = await loginAdmin(9631, "owner");
  const { admin: target } = await loginAdmin(9632, "supervisor");

  const response = await server.request(
    "PATCH",
    `/api/admin/users/${target.id}/permissions`,
    {
      token: ownerToken,
      body: {
        permission_level: "supervisor",
        status: "inactive",
        permissions: ["workers:read"],
      },
    },
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));

  const permissionsLog = state.securityAuditLogs.find(
    (item) =>
      item.event_type === "admin_permissions_changed" && item.actor_account_id === owner.id,
  );
  const statusLog = state.securityAuditLogs.find(
    (item) => item.event_type === "admin_status_changed" && item.actor_account_id === owner.id,
  );

  assert.ok(permissionsLog);
  assert.deepEqual(
    (permissionsLog.metadata as { after?: { permissions?: string[] } } | null)?.after
      ?.permissions,
    ["workers:read"],
  );

  assert.ok(statusLog);
  assert.equal(
    (statusLog.metadata as { before?: { status?: string } } | null)?.before?.status,
    "active",
  );
  assert.equal(
    (statusLog.metadata as { after?: { status?: string } } | null)?.after?.status,
    "inactive",
  );
});

test("Mobile app version create/update write mobile_app_version_* SecurityAuditLog events", async () => {
  const { token, admin } = await loginAdmin(9641, "owner");

  const created = await server.request("POST", "/api/admin/mobile-app-versions", {
    token,
    body: { version: "9.6.41", build_number: 96410 },
  });

  assert.equal(created.status, 201, JSON.stringify(created.body));

  const createdLog = state.securityAuditLogs.find(
    (item) =>
      item.event_type === "mobile_app_version_created" && item.actor_account_id === admin.id,
  );

  assert.ok(createdLog);
  assert.equal(
    (createdLog.metadata as { after?: { version?: string } } | null)?.after?.version,
    "9.6.41",
  );

  const updated = await server.request(
    "PATCH",
    `/api/admin/mobile-app-versions/${created.body.id}`,
    { token, body: { release_message: "Updated release message" } },
  );

  assert.equal(updated.status, 200, JSON.stringify(updated.body));

  const updatedLog = state.securityAuditLogs.find(
    (item) =>
      item.event_type === "mobile_app_version_updated" && item.actor_account_id === admin.id,
  );

  assert.ok(updatedLog);
  assert.equal(
    (updatedLog.metadata as { after?: { release_message?: string } } | null)?.after
      ?.release_message,
    "Updated release message",
  );
});

test("POST /api/admin/mobile-app-versions does not report success when the paired SecurityAuditLog write fails (27.14.2)", async () => {
  const { token } = await loginAdmin(9642, "owner");

  state.forceSecurityAuditLogWriteFailure = true;

  try {
    const response = await server.request("POST", "/api/admin/mobile-app-versions", {
      token,
      body: { version: "9.6.42", build_number: 96420 },
    });

    // create + audit เขียนคู่กันใน transaction เดียว (ดู mobile-app-version.service.ts) — ถ้า audit
    // write พัง ทั้งคู่ต้อง fail ไปด้วย ไม่ใช่ report 201 สำเร็จทั้งที่ไม่มีหลักฐานใน audit log จริง
    // (route test harness นี้ไม่ได้จำลอง DB rollback จริง — ดู
    // test/integration/database/mobile-app-version-audit.integration.test.ts สำหรับ proof ว่าแถวใน
    // DB จริงถูก rollback ด้วย)
    assert.equal(response.status, 500, JSON.stringify(response.body));

    const createdLog = state.securityAuditLogs.find(
      (item) => item.event_type === "mobile_app_version_created",
    );

    assert.equal(createdLog, undefined);
  } finally {
    state.forceSecurityAuditLogWriteFailure = false;
  }
});

test("PATCH /api/admin/mobile-app-versions/:id does not report success when the paired SecurityAuditLog write fails (27.14.2)", async () => {
  const { token } = await loginAdmin(9643, "owner");
  const scheduled = addMobileAppVersion({ version: "9.6.43", build_number: 96430 });

  state.forceSecurityAuditLogWriteFailure = true;

  try {
    const response = await server.request(
      "PATCH",
      `/api/admin/mobile-app-versions/${scheduled.id}`,
      { token, body: { release_message: "Should not persist" } },
    );

    assert.equal(response.status, 500, JSON.stringify(response.body));

    const updatedLog = state.securityAuditLogs.find(
      (item) => item.event_type === "mobile_app_version_updated",
    );

    assert.equal(updatedLog, undefined);
  } finally {
    state.forceSecurityAuditLogWriteFailure = false;
  }
});

test("Redaction sweep: no SecurityAuditLog event ever stores the plaintext password/secret involved in the flow that produced it, across login failure, password change, password reset, and secret rotation (27.12 item 4 + item 9)", async () => {
  const { token: ownerToken, admin: owner } = await loginAdmin(9651, "owner");
  const target = addAdmin(9652, await password.hashPassword("Original@Password999999"));
  target.permission_level = "manager";

  const wrongPassword = "WrongDistinctivePassword_XYZ999888";
  const changedOwnPassword = "OwnerNewDistinctivePassword_ABC777666";
  const resetTargetPassword = "TargetResetDistinctivePassword_DEF555444";

  const failedLogin = await server.request("POST", "/api/auth/login", {
    body: { username: owner.username, password: wrongPassword },
  });

  assert.equal(failedLogin.status, 401);

  const passwordChange = await server.request("PATCH", "/api/auth/me/password", {
    token: ownerToken,
    body: {
      current_password: "Admin@123456",
      new_password: changedOwnPassword,
    },
  });

  assert.equal(passwordChange.status, 200, JSON.stringify(passwordChange.body));

  // Re-login เพราะ session เดิมถูก revoke ตอนเปลี่ยนรหัสผ่านตัวเอง (revokeActiveByAccountIdExcept
  // ยกเว้นเฉพาะ session ปัจจุบัน — เผื่อพฤติกรรมเปลี่ยนในอนาคตจึง login ใหม่ให้ชัดเจนไม่พึ่ง token เดิม)
  const relogin = await server.request("POST", "/api/auth/login", {
    body: { username: owner.username, password: changedOwnPassword },
  });

  assert.equal(relogin.status, 200, JSON.stringify(relogin.body));

  const resetTarget = await server.request(
    "PATCH",
    `/api/admin/admins/${target.id}/password`,
    {
      token: relogin.body.access_token,
      body: { new_password: resetTargetPassword },
    },
  );

  assert.equal(resetTarget.status, 200, JSON.stringify(resetTarget.body));

  addGateClient("gate-redaction-9651", await password.hashPassword("GateSecret@Original123456"));

  const rotateSecret = await server.request(
    "POST",
    "/api/admin/gate-clients/gate-redaction-9651/secret/rotate",
    { token: relogin.body.access_token },
  );

  assert.equal(rotateSecret.status, 200, JSON.stringify(rotateSecret.body));

  const allLogsJson = JSON.stringify(state.securityAuditLogs);

  for (const secret of [
    wrongPassword,
    changedOwnPassword,
    resetTargetPassword,
    rotateSecret.body.client_secret,
    "Admin@123456",
    "Original@Password999999",
    "GateSecret@Original123456",
  ]) {
    assert.equal(
      allLogsJson.includes(secret),
      false,
      `SecurityAuditLog must never contain the plaintext secret: ${secret}`,
    );
  }

  assert.equal(allLogsJson.toLowerCase().includes("password_hash"), false);
  assert.equal(allLogsJson.toLowerCase().includes("secret_hash"), false);
  assert.equal(allLogsJson.toLowerCase().includes("access_token"), false);
  assert.equal(allLogsJson.toLowerCase().includes("refresh_token"), false);
});
