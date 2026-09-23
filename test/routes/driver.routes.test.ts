import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { addTicketForTicketJob, addDispatchableJob, resetRouteTestState, restoreRouteTestLoader, startRouteTestServer, state, type TestServer } from "../helpers/app-test-harness";
import { driverSessionRepositoryMock } from "../helpers/app-test-repository-mocks";
import { clearDriverQrRateLimitBucketsForTest } from "../../src/middlewares/driver-qr-rate-limit.middleware";

let server: TestServer;

/* -------------------------------------- Test Helpers -------------------------------------- */

// Function สร้าง vehicle job สถานะ WAIT (ยังไม่ dispatch) สำหรับ test flow ของ Driver
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

/* -------------------------------------- Hooks -------------------------------------- */

before(async () => {
  server = await startRouteTestServer();
});

beforeEach(() => {
  resetRouteTestState();
  clearDriverQrRateLimitBucketsForTest();
});

after(async () => {
  await server.close();
  restoreRouteTestLoader();
});

/* -------------------------------------- POST /api/driver/qr-sessions -------------------------------------- */

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

test("POST /api/driver/qr-sessions without a DeviceId (legacy client) still succeeds and counts as its own device", async () => {
  const job = addWaitingDriverJob(5);

  const result = await createDriverSession(job.driver_qr_token);

  assert.equal(result.status, 201);
  assert.equal(result.body.active_device_count, 1);
});

/* -------------------------------------- GET /api/driver/jobs/current -------------------------------------- */

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

test("GET /api/driver/jobs/current requires X-Driver-Device-Id when the session was created with a DeviceId", async () => {
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

test("GET /api/driver/jobs/current works without X-Driver-Device-Id for a legacy session created without DeviceId", async () => {
  const job = addWaitingDriverJob(8);
  const session = await createDriverSession(job.driver_qr_token);

  const result = await server.request("GET", "/api/driver/jobs/current", {
    token: session.body.driver_session_token,
  });

  assert.equal(result.status, 200);
});

/* -------------------------------------- POST /api/driver/jobs/:ticketNumber/ready -------------------------------------- */

test("POST /api/driver/jobs/:ticketNumber/ready marks the job WORKING and returns WAITING_FOR_WORKER when no worker is available", async () => {
  const job = addWaitingDriverJob(9, 2);
  const session = await createDriverSession(job.driver_qr_token, "device-1");

  const result = await server.request(
    "POST",
    `/api/driver/jobs/${job.ticket_number}/ready`,
    {
      token: session.body.driver_session_token,
      headers: { "X-Driver-Device-Id": "device-1" },
    },
  );

  assert.equal(result.status, 200);
  assert.equal(result.body.vehicle_job.status, "WORKING");
  assert.equal(result.body.operation_status, "WAITING_FOR_WORKER");
});

test("POST /api/driver/jobs/:ticketNumber/ready rejects a second call once the job is no longer WAIT", async () => {
  const job = addWaitingDriverJob(10);
  const session = await createDriverSession(job.driver_qr_token, "device-1");

  const options = {
    token: session.body.driver_session_token,
    headers: { "X-Driver-Device-Id": "device-1" },
  };
  const first = await server.request(
    "POST",
    `/api/driver/jobs/${job.ticket_number}/ready`,
    options,
  );
  const second = await server.request(
    "POST",
    `/api/driver/jobs/${job.ticket_number}/ready`,
    options,
  );

  assert.equal(first.status, 200);
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "VEHICLE_JOB_NOT_READY");
});

test("POST /api/driver/jobs/:ticketNumber/ready rejects a ticketNumber the session is not bound to", async () => {
  const job = addWaitingDriverJob(11);
  const otherJob = addWaitingDriverJob(12);
  const session = await createDriverSession(job.driver_qr_token, "device-1");

  const result = await server.request(
    "POST",
    `/api/driver/jobs/${otherJob.ticket_number}/ready`,
    {
      token: session.body.driver_session_token,
      headers: { "X-Driver-Device-Id": "device-1" },
    },
  );

  assert.equal(result.status, 403);
  assert.equal(result.body.code, "DRIVER_JOB_FORBIDDEN");
});

/* -------------------------------------- Terminal grace period -------------------------------------- */

test("terminal grace period lets an existing session keep reading but rejects ready", async () => {
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

  const readyAttempt = await server.request(
    "POST",
    `/api/driver/jobs/${job.ticket_number}/ready`,
    options,
  );
  assert.equal(readyAttempt.status, 409);
  assert.equal(readyAttempt.body.code, "VEHICLE_JOB_CLOSED");
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

/* -------------------------------------- GET /api/driver/jobs/stream -------------------------------------- */

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

    assert.match(chunk, /event: DRIVER_JOB_SNAPSHOT/);
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

    assert.match(chunk, /event: DRIVER_SESSION_CLOSED/);

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

    assert.match(chunk, /event: DRIVER_SESSION_CLOSED/);
  } finally {
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});
