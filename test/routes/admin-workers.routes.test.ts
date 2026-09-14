import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { addAdmin, addWorker, getPassword, resetRouteTestState, restoreRouteTestLoader, startRouteTestServer, state, type TestServer } from "../helpers/app-test-harness";

let server: TestServer;
let password: typeof import("../../src/utils/password");

/* -------------------------------------- Test Helpers -------------------------------------- */

// Function จัดการ login job admin สำหรับ test
async function loginJobAdmin(accountId: number): Promise<{ token: string }> {
  const passwordHash = await password.hashPassword("Admin@123456");
  const admin = addAdmin(accountId, passwordHash);
  state.adminPermissions.set(admin.id, [
    "workers:read",
    "workers:create",
    "workers:update",
    "workers:reset_password",
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
  };
}

/* -------------------------------------- Test Lifecycle -------------------------------------- */

before(async () => {
  password = await getPassword();
  server = await startRouteTestServer();
});

beforeEach(() => {
  resetRouteTestState();
});

after(async () => {
  await server.close();
  restoreRouteTestLoader();
});

/* -------------------------------------- Admin Users Route Tests -------------------------------------- */

test("GET /api/admin/users returns Phone alongside existing fields for every worker", async () => {
  const { token } = await loginJobAdmin(9700);
  const worker = addWorker(9701);
  worker.telephone = "0899999999";

  const response = await server.request("GET", "/api/admin/users", {
    token,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.data.length, 1);

  const item = response.body.data[0];

  assert.deepEqual(Object.keys(item).sort(), [
    "full_name",
    "labor_color",
    "phone",
    "shirt_number",
    "status",
    "updated_at",
    "work_schedule",
    "work_start_date",
    "worker_code",
  ]);
  assert.equal(item.worker_code, worker.labor_code);
  assert.equal(item.full_name, worker.full_name);
  assert.equal(item.phone, "0899999999");
  assert.equal(item.labor_color, worker.labor_color);
  assert.equal(item.shirt_number, worker.coat_no);
  assert.equal(item.status, worker.status === 1 ? "active" : "inactive");
});

test("GET /api/admin/users filters by worker_code, full_name, shirt_number, and shift", async () => {
  const { token } = await loginJobAdmin(9720);
  const morningWorker = addWorker(9721);
  const eveningWorker = addWorker(9722);
  eveningWorker.time_work = "Evening";

  const byWorkerCode = await server.request(
    "GET",
    `/api/admin/users?worker_code=${morningWorker.labor_code.toLowerCase()}`,
    { token },
  );

  assert.equal(byWorkerCode.status, 200);
  assert.equal(byWorkerCode.body.data.length, 1);
  assert.equal(byWorkerCode.body.data[0].worker_code, morningWorker.labor_code);

  const byFullName = await server.request(
    "GET",
    `/api/admin/users?full_name=${encodeURIComponent(morningWorker.full_name ?? "")}`,
    { token },
  );

  assert.equal(byFullName.status, 200);
  assert.equal(byFullName.body.data.length, 1);
  assert.equal(byFullName.body.data[0].worker_code, morningWorker.labor_code);

  const byShirtNumber = await server.request(
    "GET",
    `/api/admin/users?shirt_number=${morningWorker.coat_no}`,
    { token },
  );

  assert.equal(byShirtNumber.status, 200);
  assert.equal(byShirtNumber.body.data.length, 1);
  assert.equal(byShirtNumber.body.data[0].worker_code, morningWorker.labor_code);

  const byShift = await server.request("GET", "/api/admin/users?shift=EVENING", {
    token,
  });

  assert.equal(byShift.status, 200);
  assert.equal(byShift.body.data.length, 1);
  assert.equal(byShift.body.data[0].worker_code, eveningWorker.labor_code);
});

test("GET /api/admin/users returns 400 for an invalid shift value", async () => {
  const { token } = await loginJobAdmin(9730);

  const response = await server.request("GET", "/api/admin/users?shift=NIGHT", {
    token,
  });

  assert.equal(response.status, 400);
});

test("GET /api/admin/users returns Phone as null when the worker has none on file", async () => {
  const { token } = await loginJobAdmin(9710);
  const worker = addWorker(9711);
  worker.telephone = null;

  const response = await server.request("GET", "/api/admin/users", {
    token,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.data[0].worker_code, worker.labor_code);
  assert.equal(response.body.data[0].phone, null);
});

test("GET /api/admin/users/:workerCode detail still returns Phone under details (unchanged)", async () => {
  const { token } = await loginJobAdmin(9720);
  const worker = addWorker(9721);
  worker.telephone = "0888888888";

  const response = await server.request(
    "GET",
    `/api/admin/users/${worker.labor_code}`,
    { token }
  );

  assert.equal(response.status, 200);
  assert.equal(response.body.details.phone, "0888888888");
});

/* -------------------------------------- Security Audit Log Tests (27.12 phase 2-4) -------------------------------------- */

test("POST /api/admin/users writes a worker_account_created SecurityAuditLog with the acting admin as actor", async () => {
  const { token } = await loginJobAdmin(9730);

  const response = await server.request("POST", "/api/admin/users", {
    token,
    body: {
      full_name: "New Worker 9731",
      phone: "0891119731",
      nationality: "Myanmar",
      shirt_type: "Navy",
      shirt_number: "9731",
      time_work: "Morning",
      status: "active",
    },
  });

  assert.equal(response.status, 201, JSON.stringify(response.body));

  const log = state.securityAuditLogs.find(
    (item) => item.event_type === "worker_account_created" && item.actor_account_id === 9730,
  );

  assert.ok(log);
  assert.equal(log.outcome, "success");
  assert.equal(log.actor_type, "admin");
  assert.equal(
    (log.metadata as { targetWorkerCode?: string } | null)?.targetWorkerCode,
    "MN009731",
  );
});

test("PATCH /api/admin/users/:workerCode writes a worker_account_updated SecurityAuditLog with only the changed fields, and skips writing when nothing changes", async () => {
  const { token } = await loginJobAdmin(9740);
  const worker = addWorker(9741);
  worker.full_name = "Original Name";

  const changed = await server.request(
    "PATCH",
    `/api/admin/users/${worker.labor_code}`,
    { token, body: { full_name: "Updated Name" } },
  );

  assert.equal(changed.status, 200, JSON.stringify(changed.body));

  const updatedLog = state.securityAuditLogs.find(
    (item) => item.event_type === "worker_account_updated" && item.actor_account_id === 9740,
  );

  assert.ok(updatedLog);
  assert.equal(
    (updatedLog.metadata as { before?: { full_name?: string } } | null)?.before?.full_name,
    "Original Name",
  );
  assert.equal(
    (updatedLog.metadata as { after?: { full_name?: string } } | null)?.after?.full_name,
    "Updated Name",
  );

  const noopUpdateCountBefore = state.securityAuditLogs.filter(
    (item) => item.event_type === "worker_account_updated",
  ).length;

  const noop = await server.request(
    "PATCH",
    `/api/admin/users/${worker.labor_code}`,
    { token, body: { work_start_date: worker.work_start_date } },
  );

  assert.equal(noop.status, 200, JSON.stringify(noop.body));

  const noopUpdateCountAfter = state.securityAuditLogs.filter(
    (item) => item.event_type === "worker_account_updated",
  ).length;

  assert.equal(
    noopUpdateCountAfter,
    noopUpdateCountBefore,
    "must not write a worker_account_updated event when no tracked field actually changed",
  );
});

test("PATCH /api/admin/users/:workerCode/password writes an account_password_reset SecurityAuditLog referencing the target worker", async () => {
  const { token } = await loginJobAdmin(9750);
  const worker = addWorker(9751);

  const response = await server.request(
    "PATCH",
    `/api/admin/users/${worker.labor_code}/password`,
    { token, body: { new_password: "NewPassword@123456" } },
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));

  const log = state.securityAuditLogs.find(
    (item) => item.event_type === "account_password_reset" && item.actor_account_id === 9750,
  );

  assert.ok(log);
  assert.equal(log.outcome, "success");
  assert.equal(
    (log.metadata as { targetWorkerCode?: string } | null)?.targetWorkerCode,
    worker.labor_code,
  );
});
