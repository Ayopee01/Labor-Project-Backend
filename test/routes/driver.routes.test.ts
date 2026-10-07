// Import Library
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
// Import Helpers
import { addAdmin, addPendingAssignment, addTicketForTicketJob, addDispatchableJob, addWorker, getPassword, getWorkerDispatch, getWorkerQueue, resetRouteTestState, restoreRouteTestLoader, startRouteTestServer, state, type TestServer } from "../helpers/app-test-harness";
import { driverSessionRepositoryMock } from "../helpers/app-test-repository-mocks";
// Import Middlewares
import { clearDriverQrRateLimitBucketsForTest } from "../../src/middlewares/driver-qr-rate-limit.middleware";

let server: TestServer;
let password: typeof import("../../src/utils/password");
let workerQueue: typeof import("../../src/queues/worker-queue");
let workerDispatch: typeof import("../../src/queues/worker-dispatch");

/* -------------------------------------- Test Helpers -------------------------------------- */

// Function สร้าง vehicle job สถานะ WAIT (ยังไม่ dispatch) สำหรับ flow ของ Driver
function addWaitingDriverJob(id: number, workersRequired = 2) {
  const job = addDispatchableJob(id, workersRequired);

  job.status = "WAIT";
  job.dispatch_now = false;

  return job;
}

// Function สร้าง driver session ผ่าน endpoint จริง แล้วคืน token/DeviceId ที่ใช้ได้จริงใน test ถัดไป
async function createDriverSession(
  qrToken: string,
  deviceId?: string,
): Promise<{ status: number; body: any }> {
  return server.request("POST", "/api/driver/qr-sessions", {
    body: {
      QrToken: qrToken,
      ...(deviceId ? { DeviceId: deviceId } : {}),
    },
  });
}

// Function เรียก PATCH dispatch ของ Driver ด้วย device-1 (DeviceId เดียวกับที่ใช้สร้าง session ใน test)
async function requestDriverDispatch(
  ticketNumber: string,
  sessionToken: string,
  dispatch: boolean,
): Promise<{ status: number; body: any }> {
  return server.request("PATCH", `/api/driver/jobs/${ticketNumber}/dispatch`, {
    token: sessionToken,
    headers: { "X-Driver-Device-Id": "device-1" },
    body: { Dispatch: dispatch },
  });
}

// Function login admin พร้อมสิทธิ์ยกเลิก assignment สำหรับ flow ที่ต้องยกเลิกงานของ worker
async function loginCancelAdmin(accountId: number): Promise<{ token: string }> {
  const passwordHash = await password.hashPassword("Admin@123456");
  const admin = addAdmin(accountId, passwordHash);

  state.adminPermissions.set(admin.id, ["jobs:read", "jobs:cancel"]);

  const login = await server.request("POST", "/api/auth/login", {
    body: { username: admin.username, password: "Admin@123456" },
  });

  assert.equal(login.status, 200);

  return { token: login.body.access_token };
}

/* -------------------------------------- Hooks -------------------------------------- */

before(async () => {
  password = await getPassword();
  workerQueue = await getWorkerQueue();
  workerDispatch = await getWorkerDispatch();
  server = await startRouteTestServer();
});

beforeEach(async () => {
  resetRouteTestState();
  await clearDriverQrRateLimitBucketsForTest();
});

after(async () => {
  await server.close();
  restoreRouteTestLoader();
});

/* -------------------------------------- Driver QR Session Tests -------------------------------------- */

test("POST /api/driver/qr-sessions rejects an unknown QR token", async () => {
  const result = await createDriverSession("does-not-exist", "device-1");

  assert.equal(result.status, 404);
  assert.equal(result.body.code, "INVALID_DRIVER_QR");
});

test("POST /api/driver/qr-sessions rejects a QR token whose vehicle job is already closed", async () => {
  const job = addWaitingDriverJob(1);
  job.status = "COMPLETED";

  const result = await createDriverSession(job.driver_qr_token, "device-1");

  assert.equal(result.status, 409);
  assert.equal(result.body.code, "VEHICLE_JOB_CLOSED");
});

test("POST /api/driver/qr-sessions creates a session and reports ActiveDeviceCount/ActiveDeviceLimit", async () => {
  const job = addWaitingDriverJob(2);

  const result = await createDriverSession(job.driver_qr_token, "device-1");

  assert.equal(result.status, 201);
  assert.ok(result.body.driver_session_token);
  assert.equal(result.body.active_device_count, 1);
  assert.equal(result.body.active_device_limit, 2);
  assert.equal(result.body.vehicle_job.ticket_number, job.ticket_number);
});

test("POST /api/driver/qr-sessions rotates the session when the same DeviceId scans again, without consuming a new slot", async () => {
  const job = addWaitingDriverJob(3);

  const first = await createDriverSession(job.driver_qr_token, "device-1");
  const second = await createDriverSession(job.driver_qr_token, "device-1");

  assert.equal(second.status, 201);
  assert.equal(second.body.active_device_count, 1);
  assert.notEqual(second.body.driver_session_token, first.body.driver_session_token);

  const staleCheck = await server.request("GET", "/api/driver/jobs/current", {
    token: first.body.driver_session_token,
    headers: { "X-Driver-Device-Id": "device-1" },
  });

  assert.equal(staleCheck.status, 401);
  assert.equal(staleCheck.body.code, "INVALID_DRIVER_SESSION");

  const freshCheck = await server.request("GET", "/api/driver/jobs/current", {
    token: second.body.driver_session_token,
    headers: { "X-Driver-Device-Id": "device-1" },
  });

  assert.equal(freshCheck.status, 200);
});

test("POST /api/driver/qr-sessions rejects a 3rd distinct device once the limit is reached", async () => {
  const job = addWaitingDriverJob(4);

  const first = await createDriverSession(job.driver_qr_token, "device-1");
  const second = await createDriverSession(job.driver_qr_token, "device-2");
  const third = await createDriverSession(job.driver_qr_token, "device-3");

  assert.equal(first.status, 201);
  assert.equal(second.status, 201);
  assert.equal(third.status, 409);
  assert.equal(third.body.code, "DRIVER_SESSION_LIMIT_EXCEEDED");
});

test("POST /api/driver/qr-sessions rejects a request without DeviceId", async () => {
  const job = addWaitingDriverJob(5);

  const result = await createDriverSession(job.driver_qr_token);

  assert.equal(result.status, 400);
  assert.equal(result.body.code, "VALIDATION_ERROR");
  assert.equal(state.driverSessions.length, 0);
});

/* -------------------------------------- Driver Current Job Tests -------------------------------------- */

test("GET /api/driver/jobs/current rejects a missing session token", async () => {
  const result = await server.request("GET", "/api/driver/jobs/current");

  assert.equal(result.status, 401);
  assert.equal(result.body.code, "MISSING_DRIVER_SESSION");
});

test("GET /api/driver/jobs/current rejects an invalid session token", async () => {
  const result = await server.request("GET", "/api/driver/jobs/current", {
    token: "not-a-real-session",
  });

  assert.equal(result.status, 401);
  assert.equal(result.body.code, "INVALID_DRIVER_SESSION");
});

test("GET /api/driver/jobs/current requires an X-Driver-Device-Id matching the session DeviceId", async () => {
  const job = addWaitingDriverJob(6);
  const session = await createDriverSession(job.driver_qr_token, "device-1");

  const missingHeader = await server.request("GET", "/api/driver/jobs/current", {
    token: session.body.driver_session_token,
  });

  assert.equal(missingHeader.status, 401);
  assert.equal(missingHeader.body.code, "MISSING_DRIVER_DEVICE_ID");

  const wrongHeader = await server.request("GET", "/api/driver/jobs/current", {
    token: session.body.driver_session_token,
    headers: { "X-Driver-Device-Id": "some-other-device" },
  });

  assert.equal(wrongHeader.status, 401);
  assert.equal(wrongHeader.body.code, "DRIVER_DEVICE_MISMATCH");
});

test("GET /api/driver/jobs/current returns the full snapshot with a canonical OperationStatus", async () => {
  const job = addWaitingDriverJob(7);
  addTicketForTicketJob(job.id, 7001, 7002);
  const session = await createDriverSession(job.driver_qr_token, "device-1");

  const result = await server.request("GET", "/api/driver/jobs/current", {
    token: session.body.driver_session_token,
    headers: { "X-Driver-Device-Id": "device-1" },
  });

  assert.equal(result.status, 200);
  // dispatch_now=false ต้องได้ WAIT เสมอ ตาม resolveVehicleOperationStatus
  assert.equal(result.body.operation_status, "WAIT");
  assert.equal(result.body.vehicle_job.ticket_number, job.ticket_number);
  assert.equal(result.body.vehicle_job.status, "WAIT");
  assert.equal(result.body.markets.length, 1);
  assert.equal(result.body.markets[0].booth_count, 1);
  assert.equal(result.body.markets[0].booths.length, 1);
  // addTicketForTicketJob fixture สร้างสินค้าให้ 2 รายการต่อแผงเสมอ (Apple, Cabbage)
  assert.equal(result.body.markets[0].booths[0].products.length, 2);
});

/* -------------------------------------- Driver Dispatch Tests -------------------------------------- */

test("PATCH /api/driver/jobs/:ticketNumber/dispatch Dispatch:true marks the job WORKING, returns WAITING_FOR_WORKER and logs the driver as actor", async () => {
  const job = addWaitingDriverJob(9, 2);
  const session = await createDriverSession(job.driver_qr_token, "device-1");

  const result = await requestDriverDispatch(job.ticket_number, session.body.driver_session_token, true);

  assert.equal(result.status, 200);
  assert.equal(result.body.vehicle_job.status, "WORKING");
  assert.equal(result.body.operation_status, "WAITING_FOR_WORKER");
  assert.equal(job.dispatch_now, true);

  const logs = state.adminActionLogs.filter((item) => item.vehicle_job_id === job.id);

  assert.equal(logs.length, 1);
  assert.equal(logs[0].action_type, "VEHICLE_WAIT");
  assert.equal(logs[0].actor_account_id, null);
  assert.equal(logs[0].reason_code, "DRIVER_REQUESTED_DISPATCH");
  assert.equal(logs[0].metadata?.dispatch, true);
  assert.equal(logs[0].metadata?.source, "driver");
});

test("PATCH /api/driver/jobs/:ticketNumber/dispatch repeating the current state succeeds without a second log", async () => {
  const job = addWaitingDriverJob(10);
  const session = await createDriverSession(job.driver_qr_token, "device-1");
  const token = session.body.driver_session_token;

  const first = await requestDriverDispatch(job.ticket_number, token, true);
  const second = await requestDriverDispatch(job.ticket_number, token, true);

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(second.body.vehicle_job.status, "WORKING");
  assert.equal(
    state.adminActionLogs.filter((item) => item.vehicle_job_id === job.id).length,
    1,
  );

  // รถที่รอลงอยู่แล้ว สั่งรอลงซ้ำก็ต้องไม่มี log เช่นกัน
  const waitingJob = addWaitingDriverJob(15);
  const waitingSession = await createDriverSession(waitingJob.driver_qr_token, "device-1");
  const waitResult = await requestDriverDispatch(
    waitingJob.ticket_number,
    waitingSession.body.driver_session_token,
    false,
  );

  assert.equal(waitResult.status, 200);
  assert.equal(waitResult.body.operation_status, "WAIT");
  assert.equal(
    state.adminActionLogs.some((item) => item.vehicle_job_id === waitingJob.id),
    false,
  );
});

test("PATCH /api/driver/jobs/:ticketNumber/dispatch Dispatch:false after the whole team scanned (before any submission) requeues the team to the front and clears their roster", async () => {
  const job = addDispatchableJob(16, 1);
  const ticket = addTicketForTicketJob(job.id, 16001, 16002);
  const worker = addWorker(1601);
  const bystander = addWorker(1602);
  const assignment = addPendingAssignment(16011, job.id, worker.id);

  assignment.status = "SCANNED";
  assignment.scanned_at = new Date().toISOString();
  ticket.status = "WORKING";
  state.ticketWorkers.push({
    id: state.nextTicketWorkerId++,
    market_job_id: ticket.market_job_id,
    worker_id: worker.id,
    status: "WORKING",
    final_earning_amount: null,
    joined_at: new Date().toISOString(),
    cancelled_at: null,
    completed_at: null,
  });
  await workerQueue.enqueueWorker(bystander.id);

  const session = await createDriverSession(job.driver_qr_token, "device-1");
  const result = await requestDriverDispatch(job.ticket_number, session.body.driver_session_token, false);

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.operation_status, "WAIT");
  assert.equal(job.status, "WAIT");
  assert.equal(job.dispatch_now, false);
  assert.equal(assignment.status, "CANCELLED");
  assert.equal(ticket.status, "WAIT");
  assert.equal(
    state.marketJobs.find((market) => market.id === ticket.market_job_id)?.status,
    "WAIT",
  );
  assert.equal(
    state.ticketWorkers.find((item) => item.worker_id === worker.id)?.status,
    "CANCELLED",
  );

  const ranks = await workerQueue.getWorkerReadyQueueRanks([worker.id, bystander.id]);

  assert.ok((ranks.get(worker.id) ?? Infinity) < (ranks.get(bystander.id) ?? -1));

  const cancelledEvent = state.socketEvents.find(
    (item) => item.workerId === worker.id && item.event === "ASSIGNMENT_CANCELLED",
  );

  assert.ok(cancelledEvent);
  assert.equal((cancelledEvent.payload as Record<string, unknown>).reason_code, "DRIVER_REQUESTED_WAIT");

  const log = state.adminActionLogs.find((item) => item.vehicle_job_id === job.id);

  assert.ok(log);
  assert.equal(log.reason_code, "DRIVER_REQUESTED_WAIT");
  assert.deepEqual(log.metadata?.worker_ids, [worker.id]);

  // Timeline ฝั่ง Admin ต้องแสดงว่า Driver เป็นผู้ทำ ไม่ใช่ Admin
  const admin = await loginCancelAdmin(1603);
  const history = await server.request("GET", "/api/admin/vehicle-jobs/history", { token: admin.token });
  const historyItem = history.body.data.find(
    (item: { vehicle_job: { ticket_number: string } }) =>
      item.vehicle_job.ticket_number === job.ticket_number,
  );
  const driverEntry = historyItem?.timeline.find(
    (entry: { type: string }) => entry.type === "DRIVER_ACTION",
  );

  assert.ok(driverEntry, JSON.stringify(historyItem?.timeline));
  assert.equal(driverEntry.actor_type, "driver");
  assert.equal(driverEntry.description, "Driver set the vehicle job back to wait.");
  assert.equal(
    historyItem.timeline.some((entry: { type: string }) => entry.type === "ADMIN_ACTION"),
    false,
  );

  // พร้อมแล้วเปิดกลับได้ เพื่อเรียก Worker จากคิวรอบใหม่
  const reopen = await requestDriverDispatch(job.ticket_number, session.body.driver_session_token, true);

  assert.equal(reopen.status, 200);
  assert.equal(job.status, "WORKING");
  assert.equal(job.dispatch_now, true);
});

test("PATCH /api/driver/jobs/:ticketNumber/dispatch rejects both directions once any booth on the vehicle has been submitted", async () => {
  const job = addDispatchableJob(17, 1);
  const ticket = addTicketForTicketJob(job.id, 17001, 17002);
  const worker = addWorker(1701);
  const assignment = addPendingAssignment(17011, job.id, worker.id);

  assignment.status = "DELIVERED";
  ticket.status = "DELIVERED";
  state.completionSubmissions.push({
    id: 17021,
    ticket_id: ticket.id,
    status: "DELIVERED",
    confirmed_at: null,
    rejected_at: null,
    resolved_by_line_user_id: null,
    worker_count_snapshot: 1,
  });

  const session = await createDriverSession(job.driver_qr_token, "device-1");
  const token = session.body.driver_session_token;
  const waitAttempt = await requestDriverDispatch(job.ticket_number, token, false);

  assert.equal(waitAttempt.status, 409);
  assert.equal(waitAttempt.body.code, "VEHICLE_JOB_ALREADY_SUBMITTED");
  assert.equal(job.status, "WORKING");
  assert.equal(assignment.status, "DELIVERED");

  job.status = "WAIT";
  job.dispatch_now = false;

  const dispatchAttempt = await requestDriverDispatch(job.ticket_number, token, true);

  assert.equal(dispatchAttempt.status, 409);
  assert.equal(dispatchAttempt.body.code, "VEHICLE_JOB_ALREADY_SUBMITTED");
  assert.equal(state.adminActionLogs.some((item) => item.vehicle_job_id === job.id), false);
});

test("PATCH /api/driver/jobs/:ticketNumber/dispatch rejects a vehicle job whose workers were released by admin", async () => {
  const job = addDispatchableJob(18, 1);
  job.status = "RELEASED";
  const session = await createDriverSession(job.driver_qr_token, "device-1");

  const result = await requestDriverDispatch(job.ticket_number, session.body.driver_session_token, true);

  assert.equal(result.status, 409);
  assert.equal(result.body.code, "VEHICLE_JOB_RELEASED");
  assert.equal(job.status, "RELEASED");
});

test("PATCH /api/driver/jobs/:ticketNumber/dispatch rejects a request without Dispatch", async () => {
  const job = addWaitingDriverJob(20);
  const session = await createDriverSession(job.driver_qr_token, "device-1");

  const result = await server.request(
    "PATCH",
    `/api/driver/jobs/${job.ticket_number}/dispatch`,
    {
      token: session.body.driver_session_token,
      headers: { "X-Driver-Device-Id": "device-1" },
      body: {},
    },
  );

  assert.equal(result.status, 400);
  assert.equal(result.body.code, "VALIDATION_ERROR");
  assert.equal(job.status, "WAIT");
});

test("PATCH /api/driver/jobs/:ticketNumber/dispatch rejects a ticketNumber the session is not bound to", async () => {
  const job = addWaitingDriverJob(11);
  const otherJob = addWaitingDriverJob(12);
  const session = await createDriverSession(job.driver_qr_token, "device-1");

  const result = await requestDriverDispatch(otherJob.ticket_number, session.body.driver_session_token, true);

  assert.equal(result.status, 403);
  assert.equal(result.body.code, "DRIVER_JOB_FORBIDDEN");
});

/* -------------------------------------- Terminal Grace Period Tests -------------------------------------- */

test("terminal grace period lets an existing session keep reading but rejects dispatch changes", async () => {
  const job = addWaitingDriverJob(13);
  const session = await createDriverSession(job.driver_qr_token, "device-1");
  const options = {
    token: session.body.driver_session_token,
    headers: { "X-Driver-Device-Id": "device-1" },
  };

  job.status = "COMPLETED";
  await driverSessionRepositoryMock.revokeDriverSessionsByTicketJobId(job.id);

  const stillReadable = await server.request("GET", "/api/driver/jobs/current", options);
  assert.equal(stillReadable.status, 200);
  assert.equal(stillReadable.body.operation_status, "COMPLETED");

  const dispatchAttempt = await requestDriverDispatch(job.ticket_number, session.body.driver_session_token, true);
  assert.equal(dispatchAttempt.status, 409);
  assert.equal(dispatchAttempt.body.code, "VEHICLE_JOB_CLOSED");
});

test("after the terminal grace period elapses the session is fully rejected", async () => {
  const job = addWaitingDriverJob(14);
  const session = await createDriverSession(job.driver_qr_token, "device-1");
  const options = {
    token: session.body.driver_session_token,
    headers: { "X-Driver-Device-Id": "device-1" },
  };

  job.status = "CANCELLED";
  await driverSessionRepositoryMock.revokeDriverSessionsByTicketJobId(job.id);

  const driverSession = state.driverSessions.find(
    (item) => item.vehicle_job_id === job.id,
  );
  assert.ok(driverSession);
  // จำลองว่าเวลาผ่านไปเกิน grace period แล้ว
  driverSession!.read_only_until = new Date(Date.now() - 1000).toISOString();

  const expired = await server.request("GET", "/api/driver/jobs/current", options);

  assert.equal(expired.status, 401);
  assert.equal(expired.body.code, "INVALID_DRIVER_SESSION");
});

/* -------------------------------------- Driver Job Stream Tests -------------------------------------- */

test("GET /api/driver/jobs/stream rejects a missing session token", async () => {
  const result = await server.request("GET", "/api/driver/jobs/stream");

  assert.equal(result.status, 401);
  assert.equal(result.body.code, "MISSING_DRIVER_SESSION");
});

test("GET /api/driver/jobs/stream rejects a mismatched X-Driver-Device-Id", async () => {
  const job = addWaitingDriverJob(15);
  const session = await createDriverSession(job.driver_qr_token, "device-1");

  const result = await server.request("GET", "/api/driver/jobs/stream", {
    token: session.body.driver_session_token,
    headers: { "X-Driver-Device-Id": "some-other-device" },
  });

  assert.equal(result.status, 401);
  assert.equal(result.body.code, "DRIVER_DEVICE_MISMATCH");
});

test("GET /api/driver/jobs/stream opens an SSE connection and immediately sends DRIVER_JOB_SNAPSHOT", async () => {
  const job = addWaitingDriverJob(16);
  const session = await createDriverSession(job.driver_qr_token, "device-1");

  const controller = new AbortController();

  try {
    const response = await fetch(`${server.baseUrl}/api/driver/jobs/stream`, {
      headers: {
        Authorization: `Bearer ${session.body.driver_session_token}`,
        "X-Driver-Device-Id": "device-1",
      },
      signal: controller.signal,
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

    const reader = response.body!.getReader();
    const { value } = await reader.read();
    const chunk = Buffer.from(value ?? new Uint8Array()).toString("utf8");

    assert.match(chunk, /event: ?DRIVER_JOB_SNAPSHOT/);
    assert.match(chunk, /"VehicleJobId":123|VehicleJob/);
  } finally {
    controller.abort();
    // ให้ event loop มีเวลาประมวลผล "close" ของฝั่ง server ก่อนจบ test (เคลียร์ heartbeat interval)
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

test("GET /api/driver/jobs/stream is force-closed with DRIVER_SESSION_CLOSED when the same device rescans and rotates the session", async () => {
  const job = addWaitingDriverJob(17);
  const oldSession = await createDriverSession(job.driver_qr_token, "device-1");

  const controller = new AbortController();

  try {
    const response = await fetch(`${server.baseUrl}/api/driver/jobs/stream`, {
      headers: {
        Authorization: `Bearer ${oldSession.body.driver_session_token}`,
        "X-Driver-Device-Id": "device-1",
      },
      signal: controller.signal,
    });
    const reader = response.body!.getReader();

    // อ่าน DRIVER_JOB_SNAPSHOT แรกทิ้งก่อน (ยืนยันว่า connection เปิดสำเร็จ)
    const first = await reader.read();
    assert.match(Buffer.from(first.value ?? new Uint8Array()).toString("utf8"), /DRIVER_JOB_SNAPSHOT/);

    // device เดิมสแกน QR ซ้ำ — session เก่าต้องถูก rotate ทิ้งทันที รวมถึง SSE connection ของมันด้วย
    const rotated = await createDriverSession(job.driver_qr_token, "device-1");
    assert.equal(rotated.status, 201);

    const second = await reader.read();
    const chunk = Buffer.from(second.value ?? new Uint8Array()).toString("utf8");

    assert.match(chunk, /event: ?DRIVER_SESSION_CLOSED/);

    // Session เก่าต้องใช้งานไม่ได้แล้วผ่าน REST ด้วย (ยืนยันว่า revoke จริง ไม่ใช่แค่ตัด SSE)
    const staleCheck = await server.request("GET", "/api/driver/jobs/current", {
      token: oldSession.body.driver_session_token,
      headers: { "X-Driver-Device-Id": "device-1" },
    });
    assert.equal(staleCheck.status, 401);
  } finally {
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

test("GET /api/driver/jobs/stream auto-closes with DRIVER_SESSION_CLOSED once the session's own expiry time passes", async () => {
  const job = addWaitingDriverJob(18);
  const session = await createDriverSession(job.driver_qr_token, "device-1");

  // บังคับให้ session นี้ใกล้หมดอายุมากๆ (ปกติ TTL 24 ชม. จาก runtime settings) เพื่อไม่ต้องรอจริงนาน
  const driverSession = state.driverSessions.find(
    (item) => item.session_token === session.body.driver_session_token,
  );
  assert.ok(driverSession);
  driverSession!.expires_at = new Date(Date.now() + 300).toISOString();

  const controller = new AbortController();

  try {
    const response = await fetch(`${server.baseUrl}/api/driver/jobs/stream`, {
      headers: {
        Authorization: `Bearer ${session.body.driver_session_token}`,
        "X-Driver-Device-Id": "device-1",
      },
      signal: controller.signal,
    });
    const reader = response.body!.getReader();

    const first = await reader.read();
    assert.match(Buffer.from(first.value ?? new Uint8Array()).toString("utf8"), /DRIVER_JOB_SNAPSHOT/);

    const second = await reader.read();
    const chunk = Buffer.from(second.value ?? new Uint8Array()).toString("utf8");

    assert.match(chunk, /event: ?DRIVER_SESSION_CLOSED/);
  } finally {
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

/* -------------------------------------- Auto Dispatch Realtime Tests -------------------------------------- */

test("auto-dispatch publishes DRIVER_JOB_UPDATED so Driver Web moves from WAITING_FOR_WORKER to DISPATCH_NOW without reconnecting, and back on cancel", async () => {
  // dispatch_now=true ตั้งแต่ต้น (เหมือนงานที่ Driver เปิด dispatch ไปแล้วแต่ worker ยังมาไม่ครบ) ตรงกับ precondition
  // ของ WAITING_FOR_WORKER ตามสเปค (active_assignment_count < workers_required)
  const job = addDispatchableJob(19, 2);
  const session = await createDriverSession(job.driver_qr_token, "device-1");

  const controller = new AbortController();

  try {
    const response = await fetch(`${server.baseUrl}/api/driver/jobs/stream`, {
      headers: {
        Authorization: `Bearer ${session.body.driver_session_token}`,
        "X-Driver-Device-Id": "device-1",
      },
      signal: controller.signal,
    });
    const reader = response.body!.getReader();

    const snapshotChunk = Buffer.from((await reader.read()).value ?? new Uint8Array()).toString("utf8");
    assert.match(snapshotChunk, /event: ?DRIVER_JOB_SNAPSHOT/);
    assert.match(snapshotChunk, /"OperationStatus":"WAITING_FOR_WORKER"/);

    // Worker 2 คนเข้าคิว READY พร้อมกัน — ให้ dispatchReadyWorkers (auto-dispatch) จัดสรรให้ครบพอดี
    const workerA = addWorker(9801);
    const workerB = addWorker(9802);
    state.connectedWorkers.add(workerA.id);
    state.connectedWorkers.add(workerB.id);
    await workerQueue.enqueueWorker(workerA.id);
    await workerQueue.enqueueWorker(workerB.id);

    await workerDispatch.dispatchReadyWorkers();

    const dispatchNowChunk = Buffer.from((await reader.read()).value ?? new Uint8Array()).toString("utf8");
    assert.match(dispatchNowChunk, /event: ?DRIVER_JOB_UPDATED/);
    assert.match(dispatchNowChunk, /"OperationStatus":"DISPATCH_NOW"/);
    assert.equal(state.assignments.length, 2);

    // Admin ยกเลิก assignment ของ worker คนหนึ่ง — ทีมไม่ครบอีกครั้ง ต้องเห็น WAITING_FOR_WORKER กลับมา
    const admin = await loginCancelAdmin(9803);
    const cancelResult = await server.request("POST", "/api/admin/vehicle-jobs/assignment/cancel", {
      token: admin.token,
      body: {
        TicketNumber: job.ticket_number,
        WorkerCode: workerA.labor_code,
        ReasonCode: "test_cancel",
        ReasonText: "test reason",
      },
    });
    assert.equal(cancelResult.status, 200);

    const waitingAgainChunk = Buffer.from((await reader.read()).value ?? new Uint8Array()).toString("utf8");
    assert.match(waitingAgainChunk, /event: ?DRIVER_JOB_UPDATED/);
    assert.match(waitingAgainChunk, /"OperationStatus":"WAITING_FOR_WORKER"/);
  } finally {
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

/* -------------------------------------- Current Team Scan Tests -------------------------------------- */

// Function login worker ผ่าน endpoint จริง (ใช้ scan barcode เข้ารับงาน)
async function loginScanWorker(accountId: number): Promise<{ token: string; worker: ReturnType<typeof addWorker> }> {
  const passwordHash = await password.hashPassword("Worker@123456");
  const worker = addWorker(accountId, passwordHash);
  const login = await server.request("POST", "/api/auth/login", {
    body: {
      username: worker.labor_code,
      password: "Worker@123456",
      device_id: `mobile-${accountId}`,
      device_name: "Worker Mobile",
    },
  });

  assert.equal(login.status, 200);

  return { token: login.body.access_token, worker };
}

// Function login admin พร้อมสิทธิ์เปลี่ยน dispatch ของงานรถ
async function loginWaitAdmin(accountId: number): Promise<{ token: string }> {
  const passwordHash = await password.hashPassword("Admin@123456");
  const admin = addAdmin(accountId, passwordHash);

  state.adminPermissions.set(admin.id, ["jobs:read", "jobs:wait"]);

  const login = await server.request("POST", "/api/auth/login", {
    body: { username: admin.username, password: "Admin@123456" },
  });

  assert.equal(login.status, 200);

  return { token: login.body.access_token };
}

// Function เปลี่ยน assignment เป็นกดรับงานแล้ว พร้อมเวลาหมดอายุ scan
function acceptAssignment(assignment: ReturnType<typeof addPendingAssignment>): void {
  assignment.status = "ACCEPTED";
  assignment.accepted_at = new Date().toISOString();
  assignment.scan_deadline_at = new Date(Date.now() + 15 * 60_000).toISOString();
}

// Function ให้ worker scan barcode ของตลาดบนรถ
async function scanIn(token: string, ticketNo: string): Promise<void> {
  const response = await server.request("POST", "/api/workers/me/assignments/check-in-barcode", {
    token,
    body: { ticket_no: ticketNo },
  });

  assert.equal(response.status, 200, JSON.stringify(response.body));
}

for (const actor of ["driver", "admin"] as const) {
  test(`GET /api/driver/jobs/current waits for the current team to scan after ${actor} toggles dispatch true → false → true, keeping the first work_started_at`, async () => {
    const baseId = actor === "driver" ? 9910 : 9920;
    const job = addDispatchableJob(baseId, 2);
    const ticket = addTicketForTicketJob(job.id, baseId * 10 + 1);
    const ticketNo = state.marketJobs.find((market) => market.id === ticket.market_job_id)!.ticket_no;
    const session = await createDriverSession(job.driver_qr_token, "device-1");
    const driverToken = session.body.driver_session_token;
    const { token: adminToken } = await loginWaitAdmin(baseId);
    const tokens = new Map<number, string>();

    // Function อ่าน OperationStatus ปัจจุบันจาก Driver snapshot
    const getDriverStatus = async (): Promise<string> => {
      const response = await server.request("GET", "/api/driver/jobs/current", {
        token: driverToken,
        headers: { "X-Driver-Device-Id": "device-1" },
      });

      assert.equal(response.status, 200);

      return response.body.operation_status;
    };

    // Function สลับ dispatch ผ่าน actor ที่ทดสอบ
    const setDispatch = async (dispatch: boolean): Promise<void> => {
      const response =
        actor === "driver"
          ? await requestDriverDispatch(job.ticket_number, driverToken, dispatch)
          : await server.request("POST", `/api/admin/vehicle-jobs/${job.ticket_number}/wait`, {
              token: adminToken,
              body: { dispatch, reason_code: "R003", reason_text: "ทดสอบ" },
            });

      assert.equal(response.status, 200, JSON.stringify(response.body));
    };

    // รอบแรก: กดรับครบแต่ scan ไม่ครบต้องยังไม่ IN_PROGRESS
    for (const accountId of [baseId + 1, baseId + 2]) {
      const { token, worker } = await loginScanWorker(accountId);

      acceptAssignment(addPendingAssignment(accountId + 100000, job.id, worker.id));
      tokens.set(worker.id, token);
    }

    const [firstToken, secondToken] = [...tokens.values()];

    assert.equal(await getDriverStatus(), "DISPATCH_NOW");
    await scanIn(firstToken, ticketNo);
    assert.equal(await getDriverStatus(), "DISPATCH_NOW");
    await scanIn(secondToken, ticketNo);
    assert.equal(await getDriverStatus(), "IN_PROGRESS");

    const firstWorkStartedAt = job.work_started_at;

    assert.ok(firstWorkStartedAt);

    await setDispatch(false);
    assert.equal(await getDriverStatus(), "WAIT");

    // เปิดลงเลยใหม่ ทีมจากหน้าคิวถูกจ่ายงานรอบใหม่ ยังไม่มีใคร scan
    await setDispatch(true);

    const roundTwoAssignments = state.assignments.filter(
      (assignment) => assignment.vehicle_job_id === job.id && assignment.status === "PENDING",
    );

    assert.equal(roundTwoAssignments.length, 2);
    roundTwoAssignments.forEach(acceptAssignment);
    assert.equal(await getDriverStatus(), "DISPATCH_NOW");
    await scanIn(tokens.get(roundTwoAssignments[0].worker_id)!, ticketNo);
    assert.equal(await getDriverStatus(), "DISPATCH_NOW");

    // คนสุดท้ายของทีมปัจจุบัน scan แล้ว stream ต้องได้ DRIVER_JOB_UPDATED เป็น IN_PROGRESS
    const controller = new AbortController();

    try {
      const response = await fetch(`${server.baseUrl}/api/driver/jobs/stream`, {
        headers: {
          Authorization: `Bearer ${driverToken}`,
          "X-Driver-Device-Id": "device-1",
        },
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      const snapshotChunk = Buffer.from((await reader.read()).value ?? new Uint8Array()).toString("utf8");

      assert.match(snapshotChunk, /"OperationStatus":"DISPATCH_NOW"/);

      await scanIn(tokens.get(roundTwoAssignments[1].worker_id)!, ticketNo);

      const updatedChunk = Buffer.from((await reader.read()).value ?? new Uint8Array()).toString("utf8");

      assert.match(updatedChunk, /event: ?DRIVER_JOB_UPDATED/);
      assert.match(updatedChunk, /"OperationStatus":"IN_PROGRESS"/);
    } finally {
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(await getDriverStatus(), "IN_PROGRESS");
    assert.equal(job.work_started_at, firstWorkStartedAt);
  });
}

test("PATCH /api/driver/jobs/:ticketNumber/dispatch rejects repeating the current state once a booth has been submitted", async () => {
  const job = addDispatchableJob(9930, 1);
  const ticket = addTicketForTicketJob(job.id, 99301);

  ticket.status = "DELIVERED";
  state.completionSubmissions.push({
    id: 99302,
    ticket_id: ticket.id,
    status: "DELIVERED",
    confirmed_at: null,
    rejected_at: null,
    resolved_by_line_user_id: null,
    worker_count_snapshot: 1,
  });

  const session = await createDriverSession(job.driver_qr_token, "device-1");
  const result = await requestDriverDispatch(job.ticket_number, session.body.driver_session_token, true);

  assert.equal(result.status, 409);
  assert.equal(result.body.code, "VEHICLE_JOB_ALREADY_SUBMITTED");
});
