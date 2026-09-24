import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";

import { addAdmin, addDispatchableJob, addGateClient, addMarketJobForVehicle, addPendingAssignment, addTicketForTicketJob, addWorker, getPassword, getTicketFinancialService, getWorkerDispatch, getWorkerQueue, resetRouteTestState, restoreRouteTestLoader, signLineWebhookBody, startRouteTestServer, state, type TestServer } from "../helpers/app-test-harness";
import { FakeRedis } from "../helpers/app-test-infra-mocks";
import { WORKER_OPEN_APP_REASON } from "../../src/constants/status";
import { buildWorkScheduleShiftInstanceKey } from "../../src/utils/shift";
import { REDIS_CONFIG } from "../../src/config/redis.config";

let server: TestServer;
let password: typeof import("../../src/utils/password");
let workerQueue: typeof import("../../src/queues/worker-queue");
let workerDispatch: typeof import("../../src/queues/worker-dispatch");
let ticketFinancialService: typeof import("../../src/services/shared/ticket-financial.service");

/* -------------------------------------- Test Helpers -------------------------------------- */

// Function เธเธฑเธ”เธเธฒเธฃ login worker เธชเธณเธซเธฃเธฑเธ test
async function loginWorker(accountId: number): Promise<{ token: string; worker: ReturnType<typeof addWorker> }> {
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

  return {
    token: login.body.access_token,
    worker,
  };
}

// Function จำลองการล่วงเวลาของ worker presence ใน FakeRedis (แก้ last_seen_at ตรงๆ) สำหรับ test ที่ต้อง
// พิสูจน์ว่า presence กลายเป็น stale/offline แล้ว heartbeat รอบถัดไปต้องเริ่ม session ใหม่
function setWorkerPresenceLastSeenAt(accountId: number, lastSeenAt: string): void {
  const key = `${REDIS_CONFIG.workerPresenceKeyPrefix}${accountId}`;
  FakeRedis.hashes.set(key, {
    ...(FakeRedis.hashes.get(key) ?? {}),
    last_seen_at: lastSeenAt,
  });
}

// Function จำลองว่า queue entry ของ worker ถูกแก้ไขล่าสุดเมื่อไหร่ (เช่นตอนจบกะเมื่อวาน) สำหรับ test ที่
// ต้องพิสูจน์ว่า status_entered_at ของ open_app ไม่ fallback ไปใช้เวลานี้อีกต่อไป
function setWorkerQueueUpdatedAt(accountId: number, updatedAt: string): void {
  const key = `${REDIS_CONFIG.workerStatusKeyPrefix}${accountId}`;
  FakeRedis.hashes.set(key, {
    ...(FakeRedis.hashes.get(key) ?? {}),
    updated_at: updatedAt,
  });
}

// Function เธชเธฃเนเธฒเธ gate vehicle job body เธชเธณเธซเธฃเธฑเธ test
// Function สร้างเลข 14 หลักแบบ deterministic จาก seed string สำหรับ TicketNumber/TicketNo ใน test
// (validation ปัจจุบันบังคับตัวเลขล้วน 14 หลักเท่านั้น) seed เดิมจะได้เลขเดิมเสมอ
function toFourteenDigitId(seed: string): string {
  let hash = 0;

  for (let index = 0; index < seed.length; index++) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }

  return String(hash).padStart(14, "0");
}

function buildBoothJobJobBody(suffix: string) {
  return {
    TicketNumber: toFourteenDigitId(`TRUCK-20260723-${suffix}`),
    TicketNo: toFourteenDigitId(`TKT-20260723-${suffix}`),
    TicketCreatedAt: "2026-07-23T14:30:00+07:00",
    BoothCount: 1,
    MarketCode: `MARKET-${suffix}`,
    DropoffPoint: `Dropoff-${suffix}`,
    LicensePlate: `ABC-${suffix}`,
    LicensePlateProvince: "Bangkok",
    VehicleTypeCode: "PICKUP",
    VehicleTypeName: "Pickup truck",
    Booths: [
      {
        BoothCode: `STALL-${suffix}`,
        Products: [
          {
            ProductCode: "02020300",
            PackageCode: "29",
            Quantity: 180,
          },
        ],
      },
    ],
    Dispatch: true,
  };
}

// Function เธเธฑเธ”เธเธฒเธฃ gate auth headers เธชเธณเธซเธฃเธฑเธ test
async function gateAuthHeaders(
  clientId = "gate-test",
  clientSecret = "GateSecret@123456",
  status: "active" | "inactive" = "active"
): Promise<Record<string, string>> {
  if (!state.gateClients.has(clientId)) {
    addGateClient(clientId, await password.hashPassword(clientSecret), status);
  }

  return {
    Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
  };
}

// Function เธเธฑเธ”เธเธฒเธฃ login job admin เธชเธณเธซเธฃเธฑเธ test
async function loginJobAdmin(accountId: number): Promise<{ token: string }> {
  const passwordHash = await password.hashPassword("Admin@123456");
  const admin = addAdmin(accountId, passwordHash);
  state.adminPermissions.set(admin.id, [
    "jobs:read",
    "jobs:assign",
    "jobs:cancel",
    "jobs:override_count",
    "jobs:wait",
    "jobs:release_workers",
    "jobs:extend_deadline",
    "workers:force_status",
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

// Function เรียก ticketFinancialService.finalizeMarketJobFinancials ตรงๆ (ไม่ผ่าน HTTP route) แล้วตรวจว่า
// throw ApiError ด้วย statusCode/code ตามที่คาด — ใช้กับ guard ที่ caller เดียว (closeCompletedTicketJobIfReady)
// รับประกัน precondition ไว้แล้วเสมอจนเรียกผ่าน route จริงไม่ได้ (ดู pattern เดียวกับ "partial financial state" ด้านล่าง)
async function assertFinalizeRejects(
  marketJobId: number,
  statusCode: number,
  code: string,
): Promise<void> {
  await assert.rejects(
    () => ticketFinancialService.finalizeMarketJobFinancials(marketJobId),
    (error) =>
      Boolean(
        error &&
        typeof error === "object" &&
        (error as { statusCode?: number }).statusCode === statusCode &&
        (error as { code?: string }).code === code,
      ),
  );
}

function bangkokDateKey(value = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  return `${year}-${month}-${day}`;
}

function bangkokDateToUtcIso(date: string, hour = 1): string {
  return new Date(`${date}T${String(hour).padStart(2, "0")}:00:00.000+07:00`).toISOString();
}

/* -------------------------------------- Test Lifecycle -------------------------------------- */

before(async () => {
  password = await getPassword();
  workerQueue = await getWorkerQueue();
  workerDispatch = await getWorkerDispatch();
  ticketFinancialService = await getTicketFinancialService();
  server = await startRouteTestServer();
});

beforeEach(() => {
  resetRouteTestState();
});

after(async () => {
  await server.close();
  restoreRouteTestLoader();
});

/* -------------------------------------- Admin Jobs Route Tests -------------------------------------- */

describe("Force Worker Status", () => {
  test("POST /api/admin/jobs/workers/:workerCode/status/force rejects worker without WebSocket when target is ready", async () => {
    const { token } = await loginJobAdmin(9601);
    const worker = addWorker(9602);

    const response = await server.request(
      "POST",
      `/api/admin/jobs/workers/${worker.labor_code}/status/force`,
      {
        token,
        body: {
          status: "ready",
          reason_code: "test",
        },
      }
    );
    const queueEntry = await workerQueue.getWorkerQueueStatus(worker.id);

    assert.equal(response.status, 409);
    assert.equal(response.body.code, "WORKER_NOT_ONLINE");
    assert.equal(queueEntry, null);
  });

  test("POST /api/admin/jobs/workers/:workerCode/status/force rejects worker without WebSocket when target is break", async () => {
    const { token } = await loginJobAdmin(96011);
    const worker = addWorker(96021);

    const response = await server.request(
      "POST",
      `/api/admin/jobs/workers/${worker.labor_code}/status/force`,
      {
        token,
        body: {
          status: "break",
          reason_code: "test",
        },
      }
    );

    assert.equal(response.status, 409);
    assert.equal(response.body.code, "WORKER_NOT_ONLINE");
  });

  test("POST /api/admin/jobs/workers/:workerCode/status/force allows forcing open_app even without WebSocket (worker stuck in queue with a dropped socket)", async () => {
    const { token } = await loginJobAdmin(96012);
    const worker = addWorker(96022);
    await workerQueue.enqueueWorker(worker.id);

    const response = await server.request(
      "POST",
      `/api/admin/jobs/workers/${worker.labor_code}/status/force`,
      {
        token,
        body: {
          status: "open_app",
          reason_code: "test",
        },
      }
    );
    const queueEntry = await workerQueue.getWorkerQueueStatus(worker.id);

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.status, "open_app");
    assert.equal(queueEntry?.status, "open_app");
  });

  test("POST /api/admin/jobs/workers/:workerCode/status/force allows connected worker", async () => {
    const { token } = await loginJobAdmin(9611);
    const worker = addWorker(9612);
    state.connectedWorkers.add(worker.id);
    await workerQueue.recordWorkerHeartbeat(worker.id);

    const response = await server.request(
      "POST",
      `/api/admin/jobs/workers/${worker.labor_code}/status/force`,
      {
        token,
        body: {
          status: "ready",
          reason_code: "test",
        },
      }
    );
    const queueEntry = await workerQueue.getWorkerQueueStatus(worker.id);

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.body).sort(), [
      "full_name",
      "message",
      "server_time",
      "server_time_unix_ms",
      "status",
      "worker_code",
    ]);
    assert.equal(response.body.message, "Worker status forced successfully.");
    assert.equal(response.body.full_name, worker.full_name);
    assert.equal(response.body.worker_code, worker.labor_code);
    assert.equal(response.body.status, "ready");
    assert.equal(queueEntry?.status, "ready");
  });

  test("POST /api/admin/jobs/workers/:workerCode/status/force ready reopens a closed shift so the worker is requeued after the next job instead of bounced to open_app", async () => {
    const { token } = await loginJobAdmin(9613);
    const worker = addWorker(9614);
    const schedule = state.schedules.get(worker.id) as Parameters<typeof buildWorkScheduleShiftInstanceKey>[0];
    const now = new Date().toISOString();

    state.connectedWorkers.add(worker.id);
    await workerQueue.recordWorkerHeartbeat(worker.id);
    state.checkinLogs.push({
      id: state.nextCheckinLogId++,
      workerId: worker.id,
      workerCode: worker.labor_code,
      shiftInstanceKey: buildWorkScheduleShiftInstanceKey(schedule),
      timeWork: schedule.time_work,
      timeIn: schedule.time_in,
      timeOut: schedule.time_out,
      firstOnlineAt: now,
      lastOnlineAt: now,
      offlineAt: now,
      closedAt: now,
      closeReason: "assignment_timeout_limit_reached",
      acceptTimeoutStreak: 3,
      lastAcceptTimeoutAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const response = await server.request(
      "POST",
      `/api/admin/jobs/workers/${worker.labor_code}/status/force`,
      { token, body: { status: "ready", reason_code: "test" } }
    );
    const attendance = state.checkinLogs.find((item) => item.workerId === worker.id);

    assert.equal(response.status, 200);
    assert.equal(attendance?.closedAt, null);
    assert.equal(attendance?.acceptTimeoutStreak, 0);

    await workerQueue.markWorkerAssigned(worker.id);
    await workerDispatch.returnCompletedWorkersToQueue({
      vehicle_job: { ticket_number: "TICKET-REOPENED" },
      completed_worker_ids: [worker.id],
    });

    assert.equal((await workerQueue.getWorkerQueueStatus(worker.id))?.status, "ready");
  });

  test("POST /api/admin/jobs/workers/:workerCode/status/force break is rejected at the break limit without writing a 'forced' audit log", async () => {
    const { token } = await loginJobAdmin(9615);
    const worker = addWorker(9616);
    const schedule = state.schedules.get(worker.id) as Parameters<typeof buildWorkScheduleShiftInstanceKey>[0];
    const shiftInstanceKey = buildWorkScheduleShiftInstanceKey(schedule);

    state.connectedWorkers.add(worker.id);
    await workerQueue.recordWorkerHeartbeat(worker.id);

    for (let index = 0; index < 4; index += 1) {
      await workerQueue.incrementWorkerBreakCount(worker.id, shiftInstanceKey);
    }

    const logCountBefore = state.adminActionLogs.length;
    const response = await server.request(
      "POST",
      `/api/admin/jobs/workers/${worker.labor_code}/status/force`,
      { token, body: { status: "break", reason_code: "test" } }
    );

    assert.equal(response.status, 409);
    assert.equal(response.body.code, "BREAK_LIMIT_REACHED");
    assert.equal(state.adminActionLogs.length, logCountBefore);
  });

  test("POST /api/admin/jobs/workers/:workerCode/status/force rejects with 400 when reason_code is missing", async () => {
    const { token } = await loginJobAdmin(96111);
    const worker = addWorker(96121);
    state.connectedWorkers.add(worker.id);
    await workerQueue.recordWorkerHeartbeat(worker.id);

    const response = await server.request(
      "POST",
      `/api/admin/jobs/workers/${worker.labor_code}/status/force`,
      {
        token,
        body: {
          status: "ready",
        },
      }
    );

    assert.equal(response.status, 400);
  });

  test("POST /api/admin/jobs/workers/:workerCode/status/force accepts reason_text explicitly sent as null (regression: reason_text must accept null/omitted, only reason_code is required)", async () => {
    const worker = addWorker(96151);
    const { token } = await loginJobAdmin(96161);
    state.connectedWorkers.add(worker.id);
    await workerQueue.recordWorkerHeartbeat(worker.id);

    const response = await server.request(
      "POST",
      `/api/admin/jobs/workers/${worker.labor_code}/status/force`,
      {
        token,
        body: {
          status: "ready",
          reason_code: "IDLE_TOO_LONG",
          reason_text: null,
        },
      }
    );

    assert.equal(response.status, 200, JSON.stringify(response.body));

    const log = state.adminActionLogs.find(
      (item) => item.action_type === "WORKER_STATUS_FORCED" && item.actor_account_id === 96161,
    );

    assert.ok(log);
    assert.equal(log.reason_code, "IDLE_TOO_LONG");
    assert.equal(log.reason_text, null);
  });

  test("POST /api/admin/jobs/workers/:workerCode/status/force rejects any status when the worker is outside their work shift", async () => {
    const { token } = await loginJobAdmin(9631);
    const worker = addWorker(9632);
    state.connectedWorkers.add(worker.id);
    await workerQueue.recordWorkerHeartbeat(worker.id);

    // เลื่อนกะไปในอนาคต 2-3 ชั่วโมง (ตามเวลา Bangkok) เพื่อให้ "ตอนนี้" อยู่นอกกะแน่นอน — schedule ทั้งฝั่ง
    // Admin (forceAdminWorkerStatus) และฝั่ง Worker เอง อ่านจาก time_work/time_in/time_out บน MasterWorker
    // โดยตรงแล้ว (ไม่ใช่ entity แยกอีกต่อไป) แก้ที่ worker record เดียวพอ
    const bangkokFormatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Bangkok",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });

    worker.time_in = bangkokFormatter
      .format(new Date(Date.now() + 2 * 60 * 60 * 1000))
      .replace(" ", "");
    worker.time_out = bangkokFormatter
      .format(new Date(Date.now() + 3 * 60 * 60 * 1000))
      .replace(" ", "");
    state.schedules.set(worker.id, {
      id: worker.id,
      worker_id: worker.id,
      time_work: worker.time_work,
      work_date: worker.work_start_date,
      time_in: worker.time_in,
      time_out: worker.time_out,
      is_current: true,
      created_by: null,
      updated_by: null,
      created_at: worker.created_at,
      updated_at: worker.updated_at,
    });

    const readyResponse = await server.request(
      "POST",
      `/api/admin/jobs/workers/${worker.labor_code}/status/force`,
      {
        token,
        body: {
          status: "ready",
          reason_code: "test",
        },
      }
    );

    assert.equal(readyResponse.status, 403);
    assert.equal(readyResponse.body.code, "WORKER_OUTSIDE_WORK_SHIFT");

    const breakResponse = await server.request(
      "POST",
      `/api/admin/jobs/workers/${worker.labor_code}/status/force`,
      {
        token,
        body: {
          status: "break",
          reason_code: "test",
        },
      }
    );

    assert.equal(breakResponse.status, 403);
    assert.equal(breakResponse.body.code, "WORKER_OUTSIDE_WORK_SHIFT");

    const openAppResponse = await server.request(
      "POST",
      `/api/admin/jobs/workers/${worker.labor_code}/status/force`,
      {
        token,
        body: {
          status: "open_app",
          reason_code: "test",
        },
      }
    );

    assert.equal(openAppResponse.status, 403);
    assert.equal(openAppResponse.body.code, "WORKER_OUTSIDE_WORK_SHIFT");

    const queueEntry = await workerQueue.getWorkerQueueStatus(worker.id);

    assert.equal(queueEntry, null);
  });
});

describe("Worker Status Board", () => {
  test("GET /api/admin/jobs/workers/status shows queued worker when socket is disconnected", async () => {
    const { token } = await loginJobAdmin(9621);
    const worker = addWorker(9622);
    await workerQueue.enqueueWorker(worker.id);

    const response = await server.request("GET", "/api/admin/jobs/workers/status", {
      token,
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.summary.total, 1);
    assert.equal(response.body.summary.ready, 1);
    assert.equal(response.body.data[0].worker_code, worker.labor_code);
    assert.equal(response.body.data[0].shirt_number, worker.coat_no);
    assert.equal(response.body.data[0].status, "ready");
    assert.equal(response.body.data[0].socket_connected, false);
  });

  test("GET /api/admin/jobs/workers/status shows an offline worker stuck at open_app with reason_code/reason_text so Admin can find them to force back into the queue", async () => {
    const { token } = await loginJobAdmin(9623);
    const { token: workerToken, worker } = await loginWorker(9624);
    state.connectedWorkers.add(worker.id);

    const onlineResponse = await server.request("POST", "/api/workers/me/online", {
      token: workerToken,
    });
    assert.equal(onlineResponse.status, 200);

    // จำลองว่า worker พลาดสแกน QR/บาร์โค้ด (เด้งไป open_app) แล้วปิดแอปไป — ก่อนหน้านี้ hasVisibleWorkerFlow
    // filter จะซ่อน worker แบบนี้ออกจาก list ไปเลยเพราะ offline + open_app + ไม่มีงานค้าง ทำให้ Admin หา
    // worker คนนี้ไม่เจอตอนต้องการ force กลับเข้าคิว
    await workerQueue.markWorkerOpenApp(worker.id, WORKER_OPEN_APP_REASON.SCAN_TIMEOUT);
    state.connectedWorkers.delete(worker.id);

    const response = await server.request("GET", "/api/admin/jobs/workers/status", {
      token,
    });

    assert.equal(response.status, 200);
    const item = response.body.data.find(
      (row: { worker_code: string }) => row.worker_code === worker.labor_code,
    );
    assert.ok(item, "expected the offline worker with a reason_code to still be listed");
    assert.equal(item.status, "open_app");
    assert.equal(item.socket_connected, false);
    assert.equal(item.reason_code, "SCAN_TIMEOUT");
    assert.equal(
      item.reason_text,
      "ท่านสแกน QR โค้ด/บาร์โค้ดไม่ทันเวลาที่กำหนด กรุณาติดต่อเจ้าหน้าที่ (Admin)",
    );
  });

  test("GET /api/admin/jobs/workers/status always returns reason_text in Thai regardless of the worker's own app language", async () => {
    const { token } = await loginJobAdmin(9627);
    const { token: workerToken, worker } = await loginWorker(9628);
    worker.lang = "EN"; // worker.lang ตั้งภาษาแอปของ worker เอง — reason_text ฝั่ง Admin ต้องไม่อิงค่านี้
    state.connectedWorkers.add(worker.id);

    const onlineResponse = await server.request("POST", "/api/workers/me/online", {
      token: workerToken,
    });
    assert.equal(onlineResponse.status, 200);

    await workerQueue.markWorkerOpenApp(worker.id, WORKER_OPEN_APP_REASON.SCAN_TIMEOUT);
    state.connectedWorkers.delete(worker.id);

    const response = await server.request("GET", "/api/admin/jobs/workers/status", {
      token,
    });

    assert.equal(response.status, 200);
    const item = response.body.data.find(
      (row: { worker_code: string }) => row.worker_code === worker.labor_code,
    );
    assert.ok(item, "expected the offline worker with a reason_code to still be listed");
    assert.equal(item.reason_code, "SCAN_TIMEOUT");
    assert.equal(
      item.reason_text,
      "ท่านสแกน QR โค้ด/บาร์โค้ดไม่ทันเวลาที่กำหนด กรุณาติดต่อเจ้าหน้าที่ (Admin)",
    );
  });

  test("GET /api/admin/jobs/workers/status omits reason_code/reason_text once a worker whose shift attendance was closed is back at status ready", async () => {
    const { token } = await loginJobAdmin(9625);
    const worker = addWorker(9626);

    // จำลอง state เดียวกับที่ทำให้ /me/status ตอบ ACCEPT_TIMEOUT_LIMIT_REACHED ได้ (ปิดกะเพราะไม่กดรับงานครบ
    // จำนวน) แต่คราวนี้ Admin force worker กลับเข้าคิว (READY) ไปแล้วผ่าน forceAdminWorkerStatus ซึ่งไม่ได้
    // clear closedAt/closeReason ใน WorkerCheckinLog เลย — regression test กัน reason_code ค้างแสดงใน admin
    // list ทั้งที่ worker กลับมาทำงานได้ปกติแล้วจริงๆ (bug ที่เจอจาก production)
    const schedule = state.schedules.get(worker.id) as {
      time_work: string;
      time_in: string;
      time_out: string;
    };
    assert.ok(schedule, "Worker fixture must seed a default work schedule.");
    const shiftInstanceKey = buildWorkScheduleShiftInstanceKey(
      schedule as unknown as Parameters<typeof buildWorkScheduleShiftInstanceKey>[0],
    );

    state.checkinLogs.push({
      id: state.nextCheckinLogId++,
      workerId: worker.id,
      workerCode: worker.labor_code,
      shiftInstanceKey,
      timeWork: schedule.time_work,
      timeIn: schedule.time_in,
      timeOut: schedule.time_out,
      firstOnlineAt: new Date().toISOString(),
      lastOnlineAt: new Date().toISOString(),
      offlineAt: new Date().toISOString(),
      closedAt: new Date().toISOString(),
      closeReason: "assignment_timeout_limit_reached",
      acceptTimeoutStreak: 3,
      lastAcceptTimeoutAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // เทียบเท่ากับสิ่งที่ forceAdminWorkerStatus ทำตอน Admin force เป็น READY
    await workerQueue.enqueueWorker(worker.id);

    const response = await server.request("GET", "/api/admin/jobs/workers/status", {
      token,
    });

    assert.equal(response.status, 200);
    const item = response.body.data.find(
      (row: { worker_code: string }) => row.worker_code === worker.labor_code,
    );
    assert.ok(item, "expected the force-requeued worker to be listed");
    assert.equal(item.status, "ready");
    assert.equal("reason_code" in item, false);
    assert.equal("reason_text" in item, false);
  });

  test("GET /api/admin/jobs/workers/status uses the current presence session for open_app status_entered_at, not queue.updated_at from a previous shift", async () => {
    const { token } = await loginJobAdmin(96301);
    const worker = addWorker(96302);

    await workerQueue.markWorkerOpenApp(worker.id);

    // จำลองว่า queue entry นี้ถูกแก้ไขล่าสุดตอนจบกะเมื่อวาน 18:00 — ค่านี้ต้องไม่ถูกใช้เป็น status_entered_at
    // อีกต่อไป ต้องใช้เวลาที่ presence session ปัจจุบันเริ่มแทน (ข้อ 37)
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    setWorkerQueueUpdatedAt(worker.id, yesterday);

    // worker เปิดแอปใหม่วันนี้ -> heartbeat รอบแรกของ presence session ใหม่
    const beforeOpen = Date.now();
    await workerQueue.recordWorkerHeartbeat(worker.id);

    const response = await server.request("GET", "/api/admin/jobs/workers/status", { token });
    const item = response.body.data.find(
      (row: { worker_code: string }) => row.worker_code === worker.labor_code,
    );

    assert.ok(item);
    assert.equal(item.status, "open_app");
    assert.notEqual(item.statusEnteredAt, yesterday);
    assert.ok(
      new Date(item.statusEnteredAt).getTime() >= beforeOpen - 1000,
      `expected statusEnteredAt to reflect today's open, got ${item.statusEnteredAt}`,
    );
  });

  test("GET /api/admin/jobs/workers/status keeps open_app status_entered_at stable across a WebSocket reconnect within the grace period", async () => {
    const { token } = await loginJobAdmin(96311);
    const worker = addWorker(96312);

    await workerQueue.markWorkerOpenApp(worker.id);
    await workerQueue.recordWorkerHeartbeat(worker.id);

    const firstResponse = await server.request("GET", "/api/admin/jobs/workers/status", { token });
    const firstItem = firstResponse.body.data.find(
      (row: { worker_code: string }) => row.worker_code === worker.labor_code,
    );
    assert.ok(firstItem);

    // จำลอง socket หลุดแล้วต่อกลับภายใน grace period เหมือนที่ handleWorkerSocketConnected เรียก
    // recordWorkerHeartbeat ซ้ำทุกครั้งที่ connect — ต้องไม่ทำให้เวลาเข้าสถานะ open_app กระโดด
    await workerQueue.recordWorkerHeartbeat(worker.id);

    const secondResponse = await server.request("GET", "/api/admin/jobs/workers/status", { token });
    const secondItem = secondResponse.body.data.find(
      (row: { worker_code: string }) => row.worker_code === worker.labor_code,
    );

    assert.equal(secondItem.statusEnteredAt, firstItem.statusEnteredAt);
  });

  test("GET /api/admin/jobs/workers/status starts a new open_app session once presence has actually gone stale/offline", async () => {
    const { token } = await loginJobAdmin(96321);
    const worker = addWorker(96322);

    await workerQueue.markWorkerOpenApp(worker.id);
    await workerQueue.recordWorkerHeartbeat(worker.id);

    const firstResponse = await server.request("GET", "/api/admin/jobs/workers/status", { token });
    const firstItem = firstResponse.body.data.find(
      (row: { worker_code: string }) => row.worker_code === worker.labor_code,
    );
    assert.ok(firstItem);

    // จำลองว่า presence หมด stale window ไปแล้ว (worker_presence_stale_seconds = 90 วิใน test config)
    // โดยไม่มี heartbeat เข้ามาเลย 120 วิ — ต้องเริ่ม session ใหม่ ไม่ใช่คง session เดิมไว้
    setWorkerPresenceLastSeenAt(worker.id, new Date(Date.now() - 120_000).toISOString());
    await workerQueue.recordWorkerHeartbeat(worker.id);

    const secondResponse = await server.request("GET", "/api/admin/jobs/workers/status", { token });
    const secondItem = secondResponse.body.data.find(
      (row: { worker_code: string }) => row.worker_code === worker.labor_code,
    );

    assert.notEqual(secondItem.statusEnteredAt, firstItem.statusEnteredAt);
  });

  test("GET /api/admin/jobs/workers/status starts a new open_app session after presence is wiped (Redis TTL expiry / server restart)", async () => {
    const { token } = await loginJobAdmin(96331);
    const worker = addWorker(96332);

    await workerQueue.markWorkerOpenApp(worker.id);
    await workerQueue.recordWorkerHeartbeat(worker.id);

    const firstResponse = await server.request("GET", "/api/admin/jobs/workers/status", { token });
    const firstItem = firstResponse.body.data.find(
      (row: { worker_code: string }) => row.worker_code === worker.labor_code,
    );
    assert.ok(firstItem);

    // จำลอง presence key หมดอายุ (TTL) หรือ server restart — ข้อมูล presence เดิมหายไปทั้งหมด
    await workerQueue.clearWorkerPresence(worker.id);
    await workerQueue.recordWorkerHeartbeat(worker.id);

    const secondResponse = await server.request("GET", "/api/admin/jobs/workers/status", { token });
    const secondItem = secondResponse.body.data.find(
      (row: { worker_code: string }) => row.worker_code === worker.labor_code,
    );

    assert.notEqual(secondItem.statusEnteredAt, firstItem.statusEnteredAt);
  });

  test("GET /api/admin/jobs/workers/status returns assignment null when worker has no current assignment", async () => {
    const { token } = await loginJobAdmin(9910);
    const worker = addWorker(9911);
    await workerQueue.enqueueWorker(worker.id);

    const response = await server.request("GET", "/api/admin/jobs/workers/status", {
      token,
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.data[0].worker_code, worker.labor_code);
    assert.equal(response.body.data[0].assignment, null);
  });

  test("GET /api/admin/jobs/workers/status without page/limit returns everything and omits pagination", async () => {
    const { token } = await loginJobAdmin(9940);
    const workerA = addWorker(9941);
    const workerB = addWorker(9942);
    await workerQueue.enqueueWorker(workerA.id);
    await workerQueue.enqueueWorker(workerB.id);

    const response = await server.request("GET", "/api/admin/jobs/workers/status", {
      token,
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.summary.total, 2);
    assert.equal(response.body.data.length, 2);
    assert.equal(response.body.pagination, undefined);
  });

  test("GET /api/admin/jobs/workers/status paginates when page/limit are given, without changing the summary", async () => {
    const { token } = await loginJobAdmin(9950);
    const workerA = addWorker(9951);
    const workerB = addWorker(9952);
    await workerQueue.enqueueWorker(workerA.id);
    await workerQueue.enqueueWorker(workerB.id);

    const response = await server.request(
      "GET",
      "/api/admin/jobs/workers/status?page=1&limit=1",
      { token },
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.summary.total, 2);
    assert.equal(response.body.data.length, 1);
    assert.deepEqual(response.body.pagination, {
      page: 1,
      limit: 1,
      total: 2,
      total_pages: 2,
    });
  });
});

describe("Vehicle Job Financials", () => {
  test("GET /api/admin/vehicle-jobs/:ticketNo/financials returns finalized persisted financial breakdown", async () => {
    const { token } = await loginJobAdmin(9631);
    const worker = addWorker(9632);

    const job = addDispatchableJob(9630, 1);
    const ticket = addTicketForTicketJob(job.id, 19630);
    const products = state.ticketProducts.filter(
      (product) => product.ticket_id === ticket.id
    );

    const finalizedAt = "2026-08-07T10:00:00.000Z";

    job.status = "COMPLETED";

    ticket.status = "COMPLETED";
    ticket.confirmation_status = "COMPLETED";
    ticket.final_stall_amount = "34.00";
    ticket.completed_at = finalizedAt;
    ticket.financialized_at = finalizedAt;

    products[0].confirmed_quantity = "10";
    products[1].confirmed_quantity = "4";

    const ticketWorker = {
      id: state.nextTicketWorkerId++,
      market_job_id: ticket.market_job_id,
      worker_id: worker.id,
      status: "COMPLETED",
      joined_at: finalizedAt,
      cancelled_at: null,
      completed_at: finalizedAt,
    };

    state.ticketWorkers.push(ticketWorker);

    const firstFinancial = {
      id: state.nextTicketProductFinancialId++,
      ticket_product_id: products[0].id,
      confirmed_quantity: "10",
      stall_fee_raw: "15",
      stall_fee_rounded: "15",
      labor_fee_raw: "9",
      product_charge: "24",
      worker_count: 1,
      worker_payout_total: "9",
      fund_amount: "0",
      finalized_at: finalizedAt,
    };

    const secondFinancial = {
      id: state.nextTicketProductFinancialId++,
      ticket_product_id: products[1].id,
      confirmed_quantity: "4",
      stall_fee_raw: "6",
      stall_fee_rounded: "6",
      labor_fee_raw: "3.6",
      product_charge: "10",
      worker_count: 1,
      worker_payout_total: "3",
      fund_amount: "0.6",
      finalized_at: finalizedAt,
    };

    state.ticketProductFinancials.push(
      firstFinancial,
      secondFinancial
    );

    state.ticketWorkerPayments.push(
      {
        id: state.nextTicketWorkerPaymentId++,
        ticket_product_financial_id: firstFinancial.id,
        ticket_worker_id: ticketWorker.id,
        raw_amount: "9",
        remainder_amount: "0",
        final_amount: "9",
      },
      {
        id: state.nextTicketWorkerPaymentId++,
        ticket_product_financial_id: secondFinancial.id,
        ticket_worker_id: ticketWorker.id,
        raw_amount: "3.6",
        remainder_amount: "0.6",
        final_amount: "3",
      }
    );

    const response = await server.request(
      "GET",
      `/api/admin/vehicle-jobs/${job.ticket_number}/financials`,
      {
        token,
      }
    );

    assert.equal(response.status, 200);

    assert.equal(
      response.body.vehicle_job.ticket_number,
      job.ticket_number
    );

    assert.equal(
      response.body.financial_status,
      "FINALIZED"
    );

    assert.deepEqual(response.body.summary, {
      booth_count: 1,
      financialized_booth_count: 1,
      final_stall_amount: "34.00",
      labor_fee_raw: "12.6000",
      worker_payout_total: "12.00",
      fund_amount: "0.6000",
    });

    assert.equal(response.body.booths.length, 1);

    const booth = response.body.booths[0];

    assert.equal(booth.ticket_id, ticket.id);
    assert.equal(booth.boothCode, ticket.boothCode);
    assert.equal(booth.financialized, true);
    assert.equal(booth.final_stall_amount, "34.00");
    assert.equal("financialized_at" in booth, false);

    assert.deepEqual(booth.summary, {
      labor_fee_raw: "12.6000",
      worker_payout_total: "12.00",
      fund_amount: "0.6000",
    });

    assert.equal(booth.workers.length, 1);

    assert.equal(
      booth.workers[0].ticket_worker_id,
      ticketWorker.id
    );

    assert.equal(
      booth.workers[0].worker_code,
      worker.labor_code
    );

    assert.equal(
      booth.workers[0].membership_status,
      "COMPLETED"
    );

    assert.equal(
      booth.workers[0].total_amount,
      "12.00"
    );

    assert.equal(booth.products.length, 2);

    const firstProduct = booth.products[0];
    const secondProduct = booth.products[1];

    assert.equal(
      firstProduct.confirmed_quantity,
      "10.00"
    );

    assert.equal(
      firstProduct.rate_snapshot.stall_rate_snapshot,
      "1.50"
    );

    assert.equal(
      firstProduct.rate_snapshot.labor_rate_snapshot,
      "0.90"
    );

    assert.equal(
      firstProduct.financial.product_charge,
      "24.00"
    );

    assert.equal(
      firstProduct.financial.labor_fee_raw,
      "9.0000"
    );

    assert.equal(
      firstProduct.financial.worker_payout_total,
      "9.00"
    );

    assert.equal(
      firstProduct.financial.fund_amount,
      "0.0000"
    );

    assert.equal(
      firstProduct.workers[0].final_amount,
      "9.00"
    );

    assert.equal(
      secondProduct.confirmed_quantity,
      "4.00"
    );

    assert.equal(
      secondProduct.financial.product_charge,
      "10.00"
    );

    assert.equal(
      secondProduct.financial.labor_fee_raw,
      "3.6000"
    );

    assert.equal(
      secondProduct.financial.worker_payout_total,
      "3.00"
    );

    assert.equal(
      secondProduct.financial.fund_amount,
      "0.6000"
    );

    assert.equal(
      secondProduct.workers[0].final_amount,
      "3.00"
    );
  });

  test("GET /api/admin/vehicle-jobs/:ticketNo/financials returns pending financial status before financialization", async () => {
    const { token } = await loginJobAdmin(9633);

    const job = addDispatchableJob(9633, 1);
    const ticket = addTicketForTicketJob(job.id, 19633);

    const response = await server.request(
      "GET",
      `/api/admin/vehicle-jobs/${job.ticket_number}/financials`,
      {
        token,
      }
    );

    assert.equal(response.status, 200);

    assert.equal(
      response.body.vehicle_job.ticket_number,
      job.ticket_number
    );

    assert.equal(
      response.body.financial_status,
      "PENDING"
    );

    assert.deepEqual(response.body.summary, {
      booth_count: 1,
      financialized_booth_count: 0,
      final_stall_amount: "0.00",
      labor_fee_raw: "0.0000",
      worker_payout_total: "0.00",
      fund_amount: "0.0000",
    });

    assert.equal(response.body.booths.length, 1);

    const booth = response.body.booths[0];

    assert.equal(booth.ticket_id, ticket.id);
    assert.equal(booth.financialized, false);
    assert.equal(booth.final_stall_amount, null);
    assert.equal(booth.completed_at, null);
    assert.equal("financialized_at" in booth, false);

    assert.deepEqual(booth.summary, {
      labor_fee_raw: "0.0000",
      worker_payout_total: "0.00",
      fund_amount: "0.0000",
    });

    assert.equal(booth.workers.length, 0);
    assert.equal(booth.products.length, 2);

    assert.equal(
      booth.products[0].confirmed_quantity,
      null
    );

    assert.equal(
      booth.products[0].financial,
      null
    );

    assert.equal(
      booth.products[0].workers.length,
      0
    );

    assert.equal(
      booth.products[1].confirmed_quantity,
      null
    );

    assert.equal(
      booth.products[1].financial,
      null
    );

    assert.equal(
      booth.products[1].workers.length,
      0
    );
  });

  test("GET /api/admin/vehicle-jobs/:ticketNo/financials returns partial financial status when only some booths are finalized", async () => {
    const { token } = await loginJobAdmin(9634);

    const job = addDispatchableJob(9634, 1);

    const firstTicket = addTicketForTicketJob(
      job.id,
      19634
    );

    const secondTicket = addTicketForTicketJob(
      job.id,
      19635
    );

    const firstProducts = state.ticketProducts.filter(
      (product) => product.ticket_id === firstTicket.id
    );

    const secondProducts = state.ticketProducts.filter(
      (product) => product.ticket_id === secondTicket.id
    );

    const finalizedAt = "2026-08-07T11:00:00.000Z";

    job.status = "WORKING";
    state.marketJobs.find((item) => item.id === firstTicket.market_job_id)!.booth_count = 2;

    firstTicket.status = "COMPLETED";
    firstTicket.confirmation_status = "COMPLETED";
    firstTicket.final_stall_amount = "34.00";
    firstTicket.completed_at = finalizedAt;
    firstTicket.financialized_at = finalizedAt;

    firstProducts[0].confirmed_quantity = "10";
    firstProducts[1].confirmed_quantity = "4";

    const firstFinancial = {
      id: state.nextTicketProductFinancialId++,
      ticket_product_id: firstProducts[0].id,
      confirmed_quantity: "10",
      stall_fee_raw: "15",
      stall_fee_rounded: "15",
      labor_fee_raw: "9",
      product_charge: "24",
      worker_count: 1,
      worker_payout_total: "9",
      fund_amount: "0",
      finalized_at: finalizedAt,
    };

    const secondFinancial = {
      id: state.nextTicketProductFinancialId++,
      ticket_product_id: firstProducts[1].id,
      confirmed_quantity: "4",
      stall_fee_raw: "6",
      stall_fee_rounded: "6",
      labor_fee_raw: "3.6",
      product_charge: "10",
      worker_count: 1,
      worker_payout_total: "3",
      fund_amount: "0.6",
      finalized_at: finalizedAt,
    };

    state.ticketProductFinancials.push(
      firstFinancial,
      secondFinancial
    );

    const response = await server.request(
      "GET",
      `/api/admin/vehicle-jobs/${job.ticket_number}/financials`,
      {
        token,
      }
    );

    assert.equal(response.status, 200);

    assert.equal(
      response.body.financial_status,
      "PARTIAL"
    );

    assert.deepEqual(response.body.summary, {
      booth_count: 2,
      financialized_booth_count: 1,
      final_stall_amount: "34.00",
      labor_fee_raw: "12.6000",
      worker_payout_total: "12.00",
      fund_amount: "0.6000",
    });

    assert.equal(response.body.booths.length, 2);

    const finalizedBooth = response.body.booths.find(
      (booth: { ticket_id: number }) =>
        booth.ticket_id === firstTicket.id
    );

    const pendingBooth = response.body.booths.find(
      (booth: { ticket_id: number }) =>
        booth.ticket_id === secondTicket.id
    );

    assert.ok(finalizedBooth);
    assert.ok(pendingBooth);

    assert.equal(
      finalizedBooth.financialized,
      true
    );

    assert.equal(
      finalizedBooth.final_stall_amount,
      "34.00"
    );

    assert.equal("financialized_at" in finalizedBooth, false);

    assert.deepEqual(finalizedBooth.summary, {
      labor_fee_raw: "12.6000",
      worker_payout_total: "12.00",
      fund_amount: "0.6000",
    });

    assert.equal(
      finalizedBooth.products.length,
      2
    );

    assert.equal(
      finalizedBooth.products[0].financial.product_charge,
      "24.00"
    );

    assert.equal(
      finalizedBooth.products[1].financial.product_charge,
      "10.00"
    );

    assert.equal(
      pendingBooth.financialized,
      false
    );

    assert.equal(
      pendingBooth.final_stall_amount,
      null
    );

    assert.equal(
      pendingBooth.completed_at,
      null
    );

    assert.equal("financialized_at" in pendingBooth, false);

    assert.deepEqual(pendingBooth.summary, {
      labor_fee_raw: "0.0000",
      worker_payout_total: "0.00",
      fund_amount: "0.0000",
    });

    assert.equal(
      pendingBooth.products.length,
      secondProducts.length
    );

    assert.ok(
      pendingBooth.products.every(
        (product: {
          confirmed_quantity: string | null;
          financial: unknown;
        }) =>
          product.confirmed_quantity === null &&
          product.financial === null
      )
    );
  });

  test("admin cancel + replacement excludes cancelled worker from booth financialization", async () => {
    const { token: workerToken, worker: firstWorker } =
      await loginWorker(9701);

    const secondWorker = addWorker(9702);
    const replacementWorker = addWorker(9703);

    const { token: adminToken } =
      await loginJobAdmin(9700);

    const job = addDispatchableJob(970, 2);
    const ticket = addTicketForTicketJob(job.id, 19700);
    const market = state.marketJobs.find(
      (item) => item.id === ticket.market_job_id
    )!;

    const products = state.ticketProducts.filter(
      (product) => product.ticket_id === ticket.id
    );

    const firstAssignment = addPendingAssignment(
      19701,
      job.id,
      firstWorker.id
    );

    const cancelledAssignment = addPendingAssignment(
      19702,
      job.id,
      secondWorker.id
    );

    const scannedAt = new Date().toISOString();

    firstAssignment.status = "SCANNED";
    firstAssignment.scanned_at = scannedAt;

    cancelledAssignment.status = "SCANNED";
    cancelledAssignment.scanned_at = scannedAt;

    const firstTicketWorker = {
      id: state.nextTicketWorkerId++,
      market_job_id: ticket.market_job_id,
      worker_id: firstWorker.id,
      status: "WORKING",
      final_earning_amount: null,
      joined_at: scannedAt,
      cancelled_at: null,
      completed_at: null,
    };

    const cancelledTicketWorker = {
      id: state.nextTicketWorkerId++,
      market_job_id: ticket.market_job_id,
      worker_id: secondWorker.id,
      status: "WORKING",
      final_earning_amount: null,
      joined_at: scannedAt,
      cancelled_at: null,
      completed_at: null,
    };

    state.ticketWorkers.push(
      firstTicketWorker,
      cancelledTicketWorker
    );

    // Admin cancel Worker B
    const cancelResponse = await server.request(
      "POST",
      "/api/admin/vehicle-jobs/assignment/cancel",
      {
        token: adminToken,
        body: {
          ticket_number: job.ticket_number,
          worker_code: secondWorker.labor_code,
          reason_code: "replacement",
        },
      }
    );

    assert.equal(cancelResponse.status, 200);
    assert.equal(
      cancelledAssignment.status,
      "CANCELLED"
    );
    assert.equal(
      state.workerAssignmentEvents.filter(
        (event) =>
          event.assignment_id === cancelledAssignment.id &&
          event.event_type === "ADMIN_CANCELLED"
      ).length,
      1
    );
    assert.equal(
      cancelledTicketWorker.status,
      "CANCELLED"
    );
    assert.ok(cancelledTicketWorker.cancelled_at);

    // Worker C เธเธฃเนเธญเธกเธฃเธฑเธเธเธฒเธเนเธซเธกเน
    await workerQueue.enqueueWorker(
      replacementWorker.id
    );

    // Admin เนเธชเน Worker C เธกเธฒเนเธ—เธ
    const assignResponse = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/assign-workers`,
      {
        token: adminToken,
        body: {
          worker_codes: [
            replacementWorker.labor_code,
          ],
          reason_code: "MANUAL_ASSIGNMENT",
        },
      }
    );

    assert.equal(assignResponse.status, 201);

    const replacementAssignment =
      state.assignments.find(
        (assignment) =>
          assignment.vehicle_job_id === job.id &&
          assignment.worker_id ===
          replacementWorker.id &&
          assignment.status === "PENDING"
      );

    assert.ok(replacementAssignment);

    // เธเธณเธฅเธญเธ Worker C accept + scan เธชเธณเน€เธฃเนเธ
    replacementAssignment.status = "SCANNED";
    replacementAssignment.scanned_at =
      new Date().toISOString();

    // Worker A เธชเนเธเธขเธญเธ”เธเธฃเธดเธ
    const submitResponse = await server.request(
      "POST",
      `/api/workers/me/assignments/tickets/complete`,
      {
        token: workerToken,
        body: {
          ticket_no: market.ticket_no,
          boothCode: ticket.boothCode,
          items: products.map(
            (product, index) => ({
              productCode: product.productCode,
              packageCode: product.packageCode,
              confirmed_quantity:
                index === 0 ? 10 : 4,
            })
          ),
        },
      }
    );

    assert.equal(submitResponse.status, 200);
    assert.equal(ticket.status, "DELIVERED");

    // เธเธณเธฅเธญเธ Vendor timeout โ’ Auto Confirm
    workerDispatch.startAssignmentTimeoutProcessing();

    const queueName =
      process.env.BULLMQ_ASSIGNMENT_TIMEOUT_QUEUE as string;

    const processor =
      state.workerProcessors.get(queueName);

    assert.ok(
      processor,
      "Assignment timeout processor must be registered."
    );

    const submission =
      state.completionSubmissions.at(-1);

    assert.ok(
      submission,
      "Completion submission must exist."
    );

    await processor({
      data: {
        ticketId: ticket.id,
        submissionId: submission.id,
        kind: "vendor_confirm",
      },
    });

    const replacementTicketWorker =
      state.ticketWorkers.find(
        (ticketWorker) =>
          ticketWorker.market_job_id === ticket.market_job_id &&
          ticketWorker.worker_id ===
          replacementWorker.id
      );

    assert.ok(replacementTicketWorker);

    // A + C Complete เนเธ•เน B เธ•เนเธญเธเธขเธฑเธ Cancelled
    assert.equal(
      firstTicketWorker.status,
      "COMPLETED"
    );

    assert.equal(
      cancelledTicketWorker.status,
      "CANCELLED"
    );

    assert.equal(
      replacementTicketWorker.status,
      "COMPLETED"
    );

    // Financial เธ•เนเธญเธเธซเธฒเธฃเนเธเน A + C = 2 เธเธ
    assert.equal(
      state.ticketProductFinancials.length,
      2
    );

    assert.ok(
      state.ticketProductFinancials.every(
        (financial) =>
          financial.worker_count === 2
      )
    );

    // Product 1: labor 9 / 2
    // Worker เนเธ”เน 4 + 4 = 8
    // Fund = 1
    assert.equal(
      state.ticketProductFinancials[0]
        .worker_payout_total,
      "8"
    );

    assert.equal(
      state.ticketProductFinancials[0]
        .fund_amount,
      "1"
    );

    // Product 2: labor 3.6 / 2
    // Worker เนเธ”เน 1 + 1 = 2
    // Fund = 1.6
    assert.equal(
      state.ticketProductFinancials[1]
        .worker_payout_total,
      "2"
    );

    // fund_amount = laborFeeRaw - workerPayoutTotal (1.6) + stall/labor rounding margin (0.4) = 2
    assert.equal(
      state.ticketProductFinancials[1]
        .fund_amount,
      "2"
    );

    // 2 Product ร— 2 Worker = 4 Payment
    assert.equal(
      state.ticketWorkerPayments.length,
      4
    );

    // Worker B เธซเนเธฒเธกเธกเธต Payment
    assert.equal(
      state.ticketWorkerPayments.some(
        (payment) =>
          payment.ticket_worker_id ===
          cancelledTicketWorker.id
      ),
      false
    );

    // Worker A เธ•เนเธญเธเธกเธต 2 Product
    assert.equal(
      state.ticketWorkerPayments.filter(
        (payment) =>
          payment.ticket_worker_id ===
          firstTicketWorker.id
      ).length,
      2
    );

    // Worker C เธ•เนเธญเธเธกเธต 2 Product
    assert.equal(
      state.ticketWorkerPayments.filter(
        (payment) =>
          payment.ticket_worker_id ===
          replacementTicketWorker.id
      ).length,
      2
    );

    // เธ•เธฃเธงเธเธเนเธฒเธ Admin Financial API เธญเธตเธเธเธฑเนเธ
    assert.equal(
      firstTicketWorker.final_earning_amount,
      "5.00"
    );

    assert.equal(
      replacementTicketWorker.final_earning_amount,
      "5.00"
    );

    assert.equal(
      cancelledTicketWorker.final_earning_amount ?? null,
      null
    );

    const financialResponse = await server.request(
      "GET",
      `/api/admin/vehicle-jobs/${job.ticket_number}/financials`,
      {
        token: adminToken,
      }
    );

    assert.equal(financialResponse.status, 200);

    assert.equal(
      financialResponse.body.financial_status,
      "FINALIZED"
    );

    assert.equal(
      financialResponse.body.summary
        .final_stall_amount,
      "34.00"
    );

    assert.equal(
      financialResponse.body.summary
        .worker_payout_total,
      "10.00"
    );

    // job-level fund_amount = sum of per-product fund_amount = product1(1) + product2(2, after stall/labor rounding margin) = 3
    assert.equal(
      financialResponse.body.summary
        .fund_amount,
      "3.0000"
    );

    const booth =
      financialResponse.body.booths[0];

    const firstWorkerSummary =
      booth.workers.find(
        (worker: { worker_code: string }) =>
          worker.worker_code ===
          firstWorker.labor_code
      );

    const cancelledWorkerSummary =
      booth.workers.find(
        (worker: { worker_code: string }) =>
          worker.worker_code ===
          secondWorker.labor_code
      );

    const replacementWorkerSummary =
      booth.workers.find(
        (worker: { worker_code: string }) =>
          worker.worker_code ===
          replacementWorker.labor_code
      );

    assert.ok(firstWorkerSummary);
    assert.ok(cancelledWorkerSummary);
    assert.ok(replacementWorkerSummary);

    assert.equal(
      firstWorkerSummary.membership_status,
      "COMPLETED"
    );

    assert.equal(
      firstWorkerSummary.total_amount,
      "5.00"
    );

    assert.equal(
      cancelledWorkerSummary.membership_status,
      "CANCELLED"
    );

    assert.equal(
      cancelledWorkerSummary.total_amount,
      "0.00"
    );

    assert.equal(
      replacementWorkerSummary.membership_status,
      "COMPLETED"
    );

    assert.equal(
      replacementWorkerSummary.total_amount,
      "5.00"
    );
  });
});

describe("Assign Workers", () => {
  test("POST /api/admin/vehicle-jobs/:ticketNumber/assign-workers rejects a worker who is outside their work shift, even while READY in queue", async () => {
    const { token: adminToken } = await loginJobAdmin(9641);
    const job = addDispatchableJob(964, 1);
    const worker = addWorker(9642);

    await workerQueue.enqueueWorker(worker.id);

    // เลื่อนกะไปในอนาคต 2-3 ชั่วโมง (ตามเวลา Bangkok) เพื่อให้ "ตอนนี้" อยู่นอกกะแน่นอน แม้สถานะคิวจะ
    // เป็น ready อยู่ก็ตาม
    const schedule = state.schedules.get(worker.id);
    assert.ok(schedule, "Worker fixture must seed a default work schedule.");
    const bangkokFormatter = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Bangkok",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });

    state.schedules.set(worker.id, {
      ...(schedule as object),
      time_in: bangkokFormatter
        .format(new Date(Date.now() + 2 * 60 * 60 * 1000))
        .replace(" ", ""),
      time_out: bangkokFormatter
        .format(new Date(Date.now() + 3 * 60 * 60 * 1000))
        .replace(" ", ""),
    });

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/assign-workers`,
      {
        token: adminToken,
        body: {
          worker_codes: [worker.labor_code],
          reason_code: "MANUAL_ASSIGNMENT",
        },
      }
    );

    assert.equal(response.status, 403);
    assert.equal(response.body.code, "WORKER_OUTSIDE_WORK_SHIFT");

    const assignment = state.assignments.find(
      (item) =>
        item.vehicle_job_id === job.id && item.worker_id === worker.id
    );

    assert.equal(assignment, undefined);
  });

  test("POST /api/admin/vehicle-jobs/:ticketNumber/assign-workers records a MANUAL_ASSIGNMENT AdminActionLog with the authenticated admin as actor, reason, and assignment/worker references", async () => {
    const adminAccountId = 9660;
    const { token: adminToken } = await loginJobAdmin(adminAccountId);
    const job = addDispatchableJob(966, 1);
    const worker = addWorker(9661);

    await workerQueue.enqueueWorker(worker.id);

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/assign-workers`,
      {
        token: adminToken,
        body: {
          worker_codes: [worker.labor_code],
          reason_code: "MANUAL_ASSIGNMENT",
          reason_text: "เติมแรงงานหลังมีคนถอนตัว",
        },
      }
    );

    assert.equal(response.status, 201);

    const assignment = state.assignments.find(
      (item) =>
        item.vehicle_job_id === job.id && item.worker_id === worker.id
    );

    assert.ok(assignment);

    const log = state.adminActionLogs.find(
      (item) =>
        item.vehicle_job_id === job.id &&
        item.action_type === "MANUAL_ASSIGNMENT"
    );

    assert.ok(log);
    assert.equal(log.reason_code, "MANUAL_ASSIGNMENT");
    assert.equal(log.reason_text, "เติมแรงงานหลังมีคนถอนตัว");
    assert.equal(log.actor_account_id, adminAccountId);
    assert.deepEqual(log.metadata?.assignment_ids, [assignment?.id]);
    assert.deepEqual(log.metadata?.worker_ids, [worker.id]);
    assert.deepEqual(log.metadata?.worker_codes, [worker.labor_code]);
  });

  test("POST /api/admin/vehicle-jobs/:ticketNumber/assign-workers rejects a request with no reason_code with 400 VALIDATION_ERROR", async () => {
    const { token: adminToken } = await loginJobAdmin(9662);
    const job = addDispatchableJob(967, 1);
    const worker = addWorker(9663);

    await workerQueue.enqueueWorker(worker.id);

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/assign-workers`,
      {
        token: adminToken,
        body: {
          worker_codes: [worker.labor_code],
        },
      }
    );

    assert.equal(response.status, 400);
    assert.equal(response.body.code, "VALIDATION_ERROR");

    const assignment = state.assignments.find(
      (item) =>
        item.vehicle_job_id === job.id && item.worker_id === worker.id
    );

    assert.equal(assignment, undefined);
  });

  test("POST /api/admin/vehicle-jobs/:ticketNumber/assign-workers returns 404 VEHICLE_JOB_NOT_FOUND when the TicketNumber does not exist", async () => {
    const { token: adminToken } = await loginJobAdmin(96950);
    const worker = addWorker(96951);

    const response = await server.request(
      "POST",
      "/api/admin/vehicle-jobs/JOB-DOES-NOT-EXIST/assign-workers",
      {
        token: adminToken,
        body: {
          worker_codes: [worker.labor_code],
          reason_code: "MANUAL_ASSIGNMENT",
        },
      }
    );

    assert.equal(response.status, 404);
    assert.equal(response.body.code, "VEHICLE_JOB_NOT_FOUND");
    assert.equal(state.assignments.length, 0);
  });

  test("POST /api/admin/vehicle-jobs/:ticketNumber/assign-workers rejects a worker whose MasterWorker.status is not ACTIVE with 403 WORKER_NOT_ACTIVE", async () => {
    const { token: adminToken } = await loginJobAdmin(96952);
    const job = addDispatchableJob(96953, 1);
    const worker = addWorker(96954);
    worker.status = 0;

    await workerQueue.enqueueWorker(worker.id);

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/assign-workers`,
      {
        token: adminToken,
        body: {
          worker_codes: [worker.labor_code],
          reason_code: "MANUAL_ASSIGNMENT",
        },
      }
    );

    assert.equal(response.status, 403);
    assert.equal(response.body.code, "WORKER_NOT_ACTIVE");

    const assignment = state.assignments.find(
      (item) =>
        item.vehicle_job_id === job.id && item.worker_id === worker.id
    );

    assert.equal(assignment, undefined);
  });

  test("POST /api/admin/vehicle-jobs/:ticketNumber/assign-workers rejects a worker who already has an active assignment elsewhere with 409 WORKER_HAS_ACTIVE_ASSIGNMENT", async () => {
    const { token: adminToken } = await loginJobAdmin(96955);
    const worker = addWorker(96956);
    const otherJob = addDispatchableJob(96957, 1);
    const existingAssignment = addPendingAssignment(196958, otherJob.id, worker.id);

    const job = addDispatchableJob(96959, 1);

    await workerQueue.enqueueWorker(worker.id);

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/assign-workers`,
      {
        token: adminToken,
        body: {
          worker_codes: [worker.labor_code],
          reason_code: "MANUAL_ASSIGNMENT",
        },
      }
    );

    assert.equal(response.status, 409);
    assert.equal(response.body.code, "WORKER_HAS_ACTIVE_ASSIGNMENT");
    // Assignment เดิมของ worker ต้องไม่ถูกแตะ และห้ามมี assignment ใหม่ถูกสร้างบนรถคันใหม่
    assert.equal(existingAssignment.status, "PENDING");
    const newAssignment = state.assignments.find(
      (item) => item.vehicle_job_id === job.id && item.worker_id === worker.id
    );

    assert.equal(newAssignment, undefined);
  });

  test("POST /api/admin/vehicle-jobs/:ticketNumber/assign-workers rejects a worker who is not READY in the queue with 409 WORKER_NOT_READY", async () => {
    const { token: adminToken } = await loginJobAdmin(96960);
    const job = addDispatchableJob(96961, 1);
    const worker = addWorker(96962);

    // ไม่เรียก workerQueue.enqueueWorker เลย -> ไม่มี queue entry สำหรับ worker คนนี้เลย

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/assign-workers`,
      {
        token: adminToken,
        body: {
          worker_codes: [worker.labor_code],
          reason_code: "MANUAL_ASSIGNMENT",
        },
      }
    );

    assert.equal(response.status, 409);
    assert.equal(response.body.code, "WORKER_NOT_READY");

    const assignment = state.assignments.find(
      (item) =>
        item.vehicle_job_id === job.id && item.worker_id === worker.id
    );

    assert.equal(assignment, undefined);
  });
});

describe("Assignment Cancel", () => {
  test("POST /api/admin/vehicle-jobs/assignment/cancel rejects with 400 when reason_code is missing (required, cannot be null)", async () => {
    const { token: adminToken } = await loginJobAdmin(9920);
    const worker = addWorker(9921);
    const job = addDispatchableJob(992, 1);
    const assignment = addPendingAssignment(19920, job.id, worker.id);

    const response = await server.request(
      "POST",
      "/api/admin/vehicle-jobs/assignment/cancel",
      {
        token: adminToken,
        body: {
          ticket_number: job.ticket_number,
          worker_code: worker.labor_code,
        },
      }
    );

    assert.equal(response.status, 400);
    assert.equal(assignment.status, "PENDING");
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number + worker_code) dispatches a replacement worker from the queue because workers_required does not shrink", async () => {
    const { token: adminToken } = await loginJobAdmin(9950);
    const cancelledWorker = addWorker(9951);
    const replacementWorker = addWorker(9952);
    const job = addDispatchableJob(995, 1);
    const assignment = addPendingAssignment(19950, job.id, cancelledWorker.id);

    await workerQueue.enqueueWorker(replacementWorker.id);

    const response = await server.request(
      "POST",
      "/api/admin/vehicle-jobs/assignment/cancel",
      {
        token: adminToken,
        body: {
          ticket_number: job.ticket_number,
          worker_code: cancelledWorker.labor_code,
          reason_code: "test",
        },
      }
    );

    assert.equal(response.status, 200);
    assert.equal(assignment.status, "CANCELLED");
    assert.equal((await workerQueue.getWorkerQueueStatus(cancelledWorker.id))?.status, "open_app");
    const replacementAssignment = state.assignments.find(
      (item) => item.vehicle_job_id === job.id && item.worker_id === replacementWorker.id
    );
    assert.equal(replacementAssignment?.status, "PENDING");
    assert.equal(
      state.assignments.filter(
        (item) => item.vehicle_job_id === job.id && item.worker_id === cancelledWorker.id
      ).length,
      1
    );
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number + worker_code) returns ASSIGNMENT_NOT_FOUND and leaves the worker's real assignment untouched when the TicketNumber does not match", async () => {
    const { token: adminToken } = await loginJobAdmin(9940);
    const worker = addWorker(9941);

    const job = addDispatchableJob(994, 1);
    const otherJob = addDispatchableJob(9940, 1);
    const assignment = addPendingAssignment(19940, job.id, worker.id);

    const response = await server.request(
      "POST",
      "/api/admin/vehicle-jobs/assignment/cancel",
      {
        token: adminToken,
        body: {
          ticket_number: otherJob.ticket_number,
          worker_code: worker.labor_code,
          reason_code: "test",
        },
      }
    );

    assert.equal(response.status, 404);
    assert.equal(response.body.code, "ASSIGNMENT_NOT_FOUND");
    assert.equal(assignment.status, "PENDING");
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number + ticket_no) includes the cancelled Business Ticket's own TicketNo in the worker push payload", async () => {
    const { worker } = await loginWorker(9661);
    const { token: adminToken } = await loginJobAdmin(9660);

    const job = addDispatchableJob(966, 1);
    const market = addMarketJobForVehicle(job.id, {
      id: 3660,
      ticket_no: "TICKET-966-3660",
      marketCode: "MARKET-966-A",
    });

    addTicketForTicketJob(job.id, 43660, market.id);

    const assignment = addPendingAssignment(19660, job.id, worker.id);
    assignment.status = "SCANNED";
    assignment.scanned_at = new Date().toISOString();
    state.connectedWorkers.add(worker.id);

    const response = await server.request(
      "POST",
      "/api/admin/vehicle-jobs/assignment/cancel",
      {
        token: adminToken,
        body: { ticket_number: job.ticket_number, ticket_no: market.ticket_no, reason_code: "test" },
      },
    );

    assert.equal(response.status, 200);

    const cancelledRealtimeEvent = state.realtimeEvents.find(
      (item) => (item as { type?: string }).type === "MARKET_JOB_CANCELLED"
    ) as { worker_payload?: { ticketNos?: string[] } } | undefined;

    assert.ok(cancelledRealtimeEvent);
    assert.deepEqual(cancelledRealtimeEvent?.worker_payload?.ticketNos, [
      market.ticket_no,
    ]);
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number + ticket_no) targets the correct Business Ticket even when marketCode repeats across a different TicketJob (target_ref=marketCode alone would have picked the wrong one)", async () => {
    const { token: adminToken } = await loginJobAdmin(9662);

    // สองรถคนละคัน ใช้ marketCode ซ้ำกัน (สถานการณ์จริง Gate ใช้ marketCode เดิมได้ข้ามรถ/ข้ามวัน) —
    // คันที่ 2 (id สูงกว่า) ถูกสร้างทีหลัง เพื่อพิสูจน์ว่า target_ref=marketCode เดี่ยวๆ (orderBy id desc)
    // จะเลือกผิดคัน แต่เส้นใหม่ที่ระบุ TicketNumber+TicketNo ตรงๆ ต้องเลือกถูกเสมอ
    const jobA = addDispatchableJob(9663, 1);
    const marketA = addMarketJobForVehicle(jobA.id, {
      id: 396630,
      ticket_no: "TICKET-9663-396630",
      marketCode: "MARKET-DUP-9663",
    });
    addTicketForTicketJob(jobA.id, 496631, marketA.id);

    const jobB = addDispatchableJob(9664, 1);
    const marketB = addMarketJobForVehicle(jobB.id, {
      id: 396640,
      ticket_no: "TICKET-9664-396640",
      marketCode: "MARKET-DUP-9663",
    });
    addTicketForTicketJob(jobB.id, 496641, marketB.id);

    const response = await server.request(
      "POST",
      "/api/admin/vehicle-jobs/assignment/cancel",
      {
        token: adminToken,
        body: { ticket_number: jobA.ticket_number, ticket_no: marketA.ticket_no, reason_code: "test" },
      },
    );

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(marketA.status, "CANCELLED");
    // marketB (คันละอันแต่ marketCode ซ้ำ) ต้องไม่ถูกแตะเลย
    assert.notEqual(marketB.status, "CANCELLED");
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number + ticket_no + boothCode) targets the correct Booth even when boothCode repeats across a different Business Ticket", async () => {
    const { token: adminToken } = await loginJobAdmin(9665);

    const job = addDispatchableJob(9666, 1);
    const marketA = addMarketJobForVehicle(job.id, {
      id: 396660,
      ticket_no: "TICKET-9666-396660",
      marketCode: "MARKET-9666-A",
    });
    const boothA = addTicketForTicketJob(job.id, 496661, marketA.id);
    boothA.boothCode = "STALL-DUP-9666";

    const marketB = addMarketJobForVehicle(job.id, {
      id: 396670,
      ticket_no: "TICKET-9666-396670",
      marketCode: "MARKET-9666-B",
    });
    const boothB = addTicketForTicketJob(job.id, 496671, marketB.id);
    boothB.boothCode = "STALL-DUP-9666";

    const response = await server.request(
      "POST",
      "/api/admin/vehicle-jobs/assignment/cancel",
      {
        token: adminToken,
        body: {
          ticket_number: job.ticket_number,
          ticket_no: marketA.ticket_no,
          boothCode: "STALL-DUP-9666",
          reason_code: "test",
        },
      },
    );

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(boothA.status, "CANCELLED");
    // boothB (คนละ Business Ticket แต่ boothCode ซ้ำ) ต้องไม่ถูกแตะเลย
    assert.notEqual(boothB.status, "CANCELLED");
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number + ticket_no) rejects with 409 if the Business Ticket is already terminal (regression: no lock/re-check existed before)", async () => {
    const { token: adminToken } = await loginJobAdmin(9667);

    const job = addDispatchableJob(9668, 1);
    const market = addMarketJobForVehicle(job.id, {
      id: 396680,
      ticket_no: "TICKET-9668-396680",
      marketCode: "MARKET-9668-A",
    });
    addTicketForTicketJob(job.id, 496681, market.id);
    market.status = "COMPLETED";

    const response = await server.request(
      "POST",
      "/api/admin/vehicle-jobs/assignment/cancel",
      {
        token: adminToken,
        body: { ticket_number: job.ticket_number, ticket_no: market.ticket_no, reason_code: "test" },
      },
    );

    assert.equal(response.status, 409);
    assert.equal(response.body.code, "MARKET_JOB_ALREADY_CLOSED");
    assert.equal(market.status, "COMPLETED");
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number + ticket_no) rejects with 409 if any booth was already submitted (DELIVERED), even though the Business Ticket itself is not terminal yet", async () => {
    const { token: adminToken } = await loginJobAdmin(96681);

    const job = addDispatchableJob(96682, 1);
    const market = addMarketJobForVehicle(job.id, {
      id: 3966820,
      ticket_no: "TICKET-96682-3966820",
      marketCode: "MARKET-96682-A",
    });
    const booth = addTicketForTicketJob(job.id, 4966821, market.id);
    booth.status = "DELIVERED";

    const response = await server.request(
      "POST",
      "/api/admin/vehicle-jobs/assignment/cancel",
      {
        token: adminToken,
        body: { ticket_number: job.ticket_number, ticket_no: market.ticket_no, reason_code: "test" },
      },
    );

    assert.equal(response.status, 409);
    assert.equal(response.body.code, "MARKET_JOB_ALREADY_SUBMITTED");
    assert.equal(market.status, "WORKING");
    assert.equal(booth.status, "DELIVERED");
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number + ticket_no) rejects with 409 if any booth is stuck in REJECT (already submitted once, admin must let it be resubmitted instead)", async () => {
    const { token: adminToken } = await loginJobAdmin(96683);

    const job = addDispatchableJob(96684, 1);
    const market = addMarketJobForVehicle(job.id, {
      id: 3966840,
      ticket_no: "TICKET-96684-3966840",
      marketCode: "MARKET-96684-A",
    });
    const booth = addTicketForTicketJob(job.id, 4966841, market.id);
    booth.status = "REJECT";

    const response = await server.request(
      "POST",
      "/api/admin/vehicle-jobs/assignment/cancel",
      {
        token: adminToken,
        body: { ticket_number: job.ticket_number, ticket_no: market.ticket_no, reason_code: "test" },
      },
    );

    assert.equal(response.status, 409);
    assert.equal(response.body.code, "MARKET_JOB_ALREADY_SUBMITTED");
    assert.equal(market.status, "WORKING");
    assert.equal(booth.status, "REJECT");
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number alone) rejects with 409 if any booth anywhere under the vehicle was already submitted (DELIVERED)", async () => {
    const { token: adminToken } = await loginJobAdmin(96685);

    const job = addDispatchableJob(96686, 1);
    const market = addMarketJobForVehicle(job.id, {
      id: 3966860,
      ticket_no: "TICKET-96686-3966860",
      marketCode: "MARKET-96686-A",
    });
    const booth = addTicketForTicketJob(job.id, 4966861, market.id);
    booth.status = "DELIVERED";

    const response = await server.request(
      "POST",
      "/api/admin/vehicle-jobs/assignment/cancel",
      {
        token: adminToken,
        body: { ticket_number: job.ticket_number, reason_code: "test" },
      },
    );

    assert.equal(response.status, 409);
    assert.equal(response.body.code, "VEHICLE_JOB_ALREADY_SUBMITTED");
    assert.equal(job.status, "WORKING");
    assert.equal(market.status, "WORKING");
    assert.equal(booth.status, "DELIVERED");
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number alone) rejects with 409 if any booth is stuck in REJECT, even under a different Business Ticket than the one an admin might expect", async () => {
    const { token: adminToken } = await loginJobAdmin(96687);

    const job = addDispatchableJob(96688, 1);
    const market = addMarketJobForVehicle(job.id, {
      id: 3966880,
      ticket_no: "TICKET-96688-3966880",
      marketCode: "MARKET-96688-A",
    });
    const booth = addTicketForTicketJob(job.id, 4966881, market.id);
    booth.status = "REJECT";

    const response = await server.request(
      "POST",
      "/api/admin/vehicle-jobs/assignment/cancel",
      {
        token: adminToken,
        body: { ticket_number: job.ticket_number, reason_code: "test" },
      },
    );

    assert.equal(response.status, 409);
    assert.equal(response.body.code, "VEHICLE_JOB_ALREADY_SUBMITTED");
    assert.equal(job.status, "WORKING");
    assert.equal(booth.status, "REJECT");
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number + ticket_no + worker_code, no boothCode) rejects with 409 if any booth under this Business Ticket was already submitted (DELIVERED) — removing the worker from the roster here would silently drop them from the payout snapshot taken later at vendor confirm time", async () => {
    const { token: adminToken } = await loginJobAdmin(96689);

    const job = addDispatchableJob(96690, 1);
    const market = addMarketJobForVehicle(job.id, {
      id: 3966900,
      ticket_no: "TICKET-96690-3966900",
      marketCode: "MARKET-96690-A",
    });
    const booth = addTicketForTicketJob(job.id, 4966901, market.id);
    booth.status = "DELIVERED";
    const worker = addWorker(96691, await password.hashPassword("Worker@123456"));
    const ticketWorker = {
      id: 4966902,
      market_job_id: market.id,
      worker_id: worker.id,
      status: "WORKING",
      joined_at: new Date().toISOString(),
      cancelled_at: null,
      completed_at: null,
    };
    state.ticketWorkers.push(ticketWorker);

    const response = await server.request(
      "POST",
      "/api/admin/vehicle-jobs/assignment/cancel",
      {
        token: adminToken,
        body: {
          ticket_number: job.ticket_number,
          ticket_no: market.ticket_no,
          worker_code: worker.labor_code,
          reason_code: "test",
        },
      },
    );

    assert.equal(response.status, 409);
    assert.equal(response.body.code, "MARKET_JOB_ALREADY_SUBMITTED");
    assert.equal(ticketWorker.status, "WORKING");
    assert.equal(booth.status, "DELIVERED");
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number + ticket_no + worker_code, no boothCode) rejects with 409 if any booth under this Business Ticket is stuck in REJECT", async () => {
    const { token: adminToken } = await loginJobAdmin(96692);

    const job = addDispatchableJob(96693, 1);
    const market = addMarketJobForVehicle(job.id, {
      id: 3966940,
      ticket_no: "TICKET-96693-3966940",
      marketCode: "MARKET-96693-A",
    });
    const booth = addTicketForTicketJob(job.id, 4966941, market.id);
    booth.status = "REJECT";
    const worker = addWorker(96694, await password.hashPassword("Worker@123456"));
    const ticketWorker = {
      id: 4966942,
      market_job_id: market.id,
      worker_id: worker.id,
      status: "WORKING",
      joined_at: new Date().toISOString(),
      cancelled_at: null,
      completed_at: null,
    };
    state.ticketWorkers.push(ticketWorker);

    const response = await server.request(
      "POST",
      "/api/admin/vehicle-jobs/assignment/cancel",
      {
        token: adminToken,
        body: {
          ticket_number: job.ticket_number,
          ticket_no: market.ticket_no,
          worker_code: worker.labor_code,
          reason_code: "test",
        },
      },
    );

    assert.equal(response.status, 409);
    assert.equal(response.body.code, "MARKET_JOB_ALREADY_SUBMITTED");
    assert.equal(ticketWorker.status, "WORKING");
    assert.equal(booth.status, "REJECT");
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number + ticket_no) does not overwrite a booth that is already COMPLETED within the same Business Ticket (regression: cascading updateMany used to have no status guard)", async () => {
    const { token: adminToken } = await loginJobAdmin(9669);

    const job = addDispatchableJob(9679, 1);
    const market = addMarketJobForVehicle(job.id, {
      id: 396790,
      ticket_no: "TICKET-9679-396790",
      marketCode: "MARKET-9679-A",
    });
    const completedBooth = addTicketForTicketJob(job.id, 496791, market.id);
    completedBooth.status = "COMPLETED";
    const openBooth = addTicketForTicketJob(job.id, 496792, market.id);
    openBooth.status = "WORKING";

    const response = await server.request(
      "POST",
      "/api/admin/vehicle-jobs/assignment/cancel",
      {
        token: adminToken,
        body: { ticket_number: job.ticket_number, ticket_no: market.ticket_no, reason_code: "test" },
      },
    );

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(market.status, "CANCELLED");
    // booth ที่ COMPLETED ไปแล้วก่อนหน้า ต้องไม่ถูกเขียนทับเป็น CANCELLED
    assert.equal(completedBooth.status, "COMPLETED");
    // booth ที่ยังไม่ terminal ต้องถูกยกเลิกตามปกติ
    assert.equal(openBooth.status, "CANCELLED");
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number only) notifies each affected worker only once, not twice", async () => {
    const { worker } = await loginWorker(9671);
    const { token: adminToken } = await loginJobAdmin(9670);

    const job = addDispatchableJob(967, 1);
    const assignment = addPendingAssignment(19670, job.id, worker.id);
    assignment.status = "SCANNED";
    assignment.scanned_at = new Date().toISOString();
    state.connectedWorkers.add(worker.id);

    const response = await server.request("POST", "/api/admin/vehicle-jobs/assignment/cancel", {
      token: adminToken,
      body: {
        ticket_number: job.ticket_number,
        reason_code: "test",
      },
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));

    // ต้องไม่มี ASSIGNMENT_CANCELLED ยิงแยกต่อคนอีกต่อไป (จุดที่เคยทำให้ push ซ้ำ)
    assert.equal(
      state.socketEvents.some(
        (item) => item.workerId === worker.id && item.event === "ASSIGNMENT_CANCELLED"
      ),
      false
    );

    // ต้องมี VEHICLE_JOB_CANCELLED แค่ครั้งเดียว ครอบคลุม worker คนนี้อยู่แล้ว
    const cancelledRealtimeEvents = state.realtimeEvents.filter(
      (item) => (item as { type?: string }).type === "VEHICLE_JOB_CANCELLED"
    ) as Array<{ worker_ids?: number[] }>;

    assert.equal(cancelledRealtimeEvents.length, 1);
    assert.deepEqual(cancelledRealtimeEvents[0].worker_ids, [worker.id]);
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number + ticket_no + boothCode + worker_code) removes the worker from just that booth's payout divisor, leaving TicketWorker.status untouched", async () => {
    const { token: adminToken } = await loginJobAdmin(9672);
    const worker = addWorker(9673);
    const job = addDispatchableJob(9674, 1);
    const ticket = addTicketForTicketJob(job.id, 199740);
    const market = state.marketJobs.find((item) => item.id === ticket.market_job_id)!;

    const ticketWorker = {
      id: state.nextTicketWorkerId++,
      market_job_id: ticket.market_job_id,
      worker_id: worker.id,
      status: "WORKING",
      final_earning_amount: null,
      joined_at: new Date().toISOString(),
      cancelled_at: null,
      completed_at: null,
    };

    state.ticketWorkers.push(ticketWorker);

    const response = await server.request("POST", "/api/admin/vehicle-jobs/assignment/cancel", {
      token: adminToken,
      body: {
        ticket_number: job.ticket_number,
        ticket_no: market.ticket_no,
        boothCode: ticket.boothCode,
        worker_code: worker.labor_code,
        reason_code: "test",
      },
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.ticket_number, job.ticket_number);
    assert.equal(response.body.ticket_no, market.ticket_no);
    assert.equal(response.body.boothCode, ticket.boothCode);
    assert.equal(response.body.worker_code, worker.labor_code);

    // TicketWorker.status ต้องไม่ถูกแตะเลย — worker ยัง WORKING ระดับ Business Ticket ปกติ
    assert.equal(ticketWorker.status, "WORKING");
    assert.equal(
      state.boothJobWorkerExclusions.some(
        (exclusion) =>
          exclusion.gate_ticket_id === ticket.id &&
          exclusion.ticket_worker_id === ticketWorker.id,
      ),
      true,
    );
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number + ticket_no + boothCode + worker_code) excludes the worker from that booth's snapshot when it later confirms, but not from a different booth's snapshot", async () => {
    const { token: workerToken, worker } = await loginWorker(96721);
    const { token: adminToken } = await loginJobAdmin(96722);

    const job = addDispatchableJob(96723, 1);
    const firstTicket = addTicketForTicketJob(job.id, 966240);
    const secondTicket = addTicketForTicketJob(job.id, 966241, firstTicket.market_job_id);
    const market = state.marketJobs.find((item) => item.id === firstTicket.market_job_id)!;

    const assignment = addPendingAssignment(966250, job.id, worker.id);
    assignment.status = "SCANNED";
    assignment.scanned_at = new Date().toISOString();

    const ticketWorker = {
      id: state.nextTicketWorkerId++,
      market_job_id: firstTicket.market_job_id,
      worker_id: worker.id,
      status: "WORKING",
      final_earning_amount: null,
      joined_at: new Date().toISOString(),
      cancelled_at: null,
      completed_at: null,
    };
    // Roster เพิ่มอีกหนึ่งคน (ไม่ผูก Assignment จริง แค่ไว้เป็น TicketWorker อีกคนของ Market Job เดียวกัน)
    // เพื่อไม่ให้การถอน ticketWorker ออกจาก firstTicket ด้านล่างกลายเป็น "ถอน Worker คนสุดท้ายออกจาก
    // Booth" ซึ่งตั้งแต่มี Fix ของ BUG-001 จะทำให้ระบบยกเลิกทั้ง Booth ให้อัตโนมัติ (ไม่ใช่ Behavior ที่
    // Test นี้ตั้งใจตรวจ — Test นี้ตรวจแค่ว่า Snapshot การถอน Worker เป็นแบบเจาะจงต่อ Booth เท่านั้น)
    const otherTicketWorker = {
      id: state.nextTicketWorkerId++,
      market_job_id: firstTicket.market_job_id,
      worker_id: worker.id + 900000,
      status: "WORKING",
      final_earning_amount: null,
      joined_at: new Date().toISOString(),
      cancelled_at: null,
      completed_at: null,
    };

    state.ticketWorkers.push(ticketWorker, otherTicketWorker);

    // ถอน worker ออกจาก firstTicket แผงเดียว ก่อน confirm ทั้งสองแผง
    const excludeResponse = await server.request(
      "POST",
      "/api/admin/vehicle-jobs/assignment/cancel",
      {
        token: adminToken,
        body: {
          ticket_number: job.ticket_number,
          ticket_no: market.ticket_no,
          boothCode: firstTicket.boothCode,
          worker_code: worker.labor_code,
          reason_code: "test",
        },
      },
    );

    assert.equal(excludeResponse.status, 200, JSON.stringify(excludeResponse.body));

    const productsFirst = state.ticketProducts.filter(
      (product) => product.ticket_id === firstTicket.id,
    );
    const productsSecond = state.ticketProducts.filter(
      (product) => product.ticket_id === secondTicket.id,
    );

    const submitFirst = await server.request(
      "POST",
      "/api/workers/me/assignments/tickets/complete",
      {
        token: workerToken,
        body: {
          ticket_no: market.ticket_no,
          boothCode: firstTicket.boothCode,
          items: productsFirst.map((product) => ({
            productCode: product.productCode,
            packageCode: product.packageCode,
            confirmed_quantity: Number(product.quantity),
          })),
        },
      },
    );

    assert.equal(submitFirst.status, 200, JSON.stringify(submitFirst.body));

    const submitSecond = await server.request(
      "POST",
      "/api/workers/me/assignments/tickets/complete",
      {
        token: workerToken,
        body: {
          ticket_no: market.ticket_no,
          boothCode: secondTicket.boothCode,
          items: productsSecond.map((product) => ({
            productCode: product.productCode,
            packageCode: product.packageCode,
            confirmed_quantity: Number(product.quantity),
          })),
        },
      },
    );

    assert.equal(submitSecond.status, 200, JSON.stringify(submitSecond.body));

    const firstSubmission = state.completionSubmissions.find(
      (submission) => submission.ticket_id === firstTicket.id,
    );
    const secondSubmission = state.completionSubmissions.find(
      (submission) => submission.ticket_id === secondTicket.id,
    );

    workerDispatch.startAssignmentTimeoutProcessing();
    const queueName = process.env.BULLMQ_ASSIGNMENT_TIMEOUT_QUEUE as string;
    const processor = state.workerProcessors.get(queueName);

    await processor!({
      data: { ticketId: firstTicket.id, submissionId: firstSubmission!.id, kind: "vendor_confirm" },
    });
    await processor!({
      data: { ticketId: secondTicket.id, submissionId: secondSubmission!.id, kind: "vendor_confirm" },
    });

    // แผงที่ถูกถอน worker ออกไปแล้ว: snapshot ต้องไม่มี worker คนนี้เลย
    assert.equal(
      state.boothJobWorkerSnapshots.some(
        (snapshot) =>
          snapshot.gate_ticket_id === firstTicket.id &&
          snapshot.ticket_worker_id === ticketWorker.id,
      ),
      false,
    );
    // แผงที่สอง (ไม่ได้ถูกถอน): snapshot ต้องยังมี worker คนนี้อยู่ตามปกติ
    assert.equal(
      state.boothJobWorkerSnapshots.some(
        (snapshot) =>
          snapshot.gate_ticket_id === secondTicket.id &&
          snapshot.ticket_worker_id === ticketWorker.id,
      ),
      true,
    );
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number + ticket_no + boothCode + worker_code) returns 404 TICKET_WORKER_NOT_FOUND when the worker is not an active member of that Business Ticket", async () => {
    const { token: adminToken } = await loginJobAdmin(9679);
    const worker = addWorker(96791);
    const job = addDispatchableJob(96792, 1);
    const ticket = addTicketForTicketJob(job.id, 967930);
    const market = state.marketJobs.find((item) => item.id === ticket.market_job_id)!;

    const response = await server.request("POST", "/api/admin/vehicle-jobs/assignment/cancel", {
      token: adminToken,
      body: {
        ticket_number: job.ticket_number,
        ticket_no: market.ticket_no,
        boothCode: ticket.boothCode,
        worker_code: worker.labor_code,
        reason_code: "test",
      },
    });

    assert.equal(response.status, 404);
    assert.equal(response.body.code, "TICKET_WORKER_NOT_FOUND");
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number + ticket_no + boothCode + worker_code) rejects with 409 if the booth was already submitted (DELIVERED)", async () => {
    const { token: adminToken } = await loginJobAdmin(96793);
    const worker = addWorker(96794);
    const job = addDispatchableJob(96795, 1);
    const ticket = addTicketForTicketJob(job.id, 967960);
    ticket.status = "DELIVERED";
    const market = state.marketJobs.find((item) => item.id === ticket.market_job_id)!;

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

    const response = await server.request("POST", "/api/admin/vehicle-jobs/assignment/cancel", {
      token: adminToken,
      body: {
        ticket_number: job.ticket_number,
        ticket_no: market.ticket_no,
        boothCode: ticket.boothCode,
        worker_code: worker.labor_code,
        reason_code: "test",
      },
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.code, "STALL_JOB_ALREADY_SUBMITTED");
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel rejects with 400 when boothCode is given without ticket_no", async () => {
    const { token: adminToken } = await loginJobAdmin(9675);
    const job = addDispatchableJob(9676, 1);

    const response = await server.request("POST", "/api/admin/vehicle-jobs/assignment/cancel", {
      token: adminToken,
      body: {
        ticket_number: job.ticket_number,
        boothCode: "STALL-ANY",
        reason_code: "test",
      },
    });

    assert.equal(response.status, 400);
    assert.equal(response.body.code, "INVALID_CANCEL_SCOPE");
  });

  // Spec item 21: Cancellation Lifecycle ระดับรถ/Business Ticket/Booth ต้อง lock+recheck ก่อนยกเลิก
  // ทั้งรถ, ไม่เขียนทับ MarketJob/BoothJob ที่ terminal ไปแล้ว, และ roll up สถานะ parent ผ่าน
  // centralized lifecycle เดียวกับ vendor confirm (closeCompletedTicketJobIfReady) หลังยกเลิก
  // ตลาด/booth เสมอ

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number only) rejects a vehicle job that is already completed, and touches nothing", async () => {
    const { token: adminToken } = await loginJobAdmin(9910);
    const job = addDispatchableJob(9911, 1);
    const ticket = addTicketForTicketJob(job.id, 199110);
    const market = state.marketJobs.find((item) => item.id === ticket.market_job_id)!;

    job.status = "COMPLETED";
    ticket.status = "COMPLETED";
    market.status = "COMPLETED";

    const response = await server.request("POST", "/api/admin/vehicle-jobs/assignment/cancel", {
      token: adminToken,
      body: { ticket_number: job.ticket_number, reason_code: "test" },
    });

    assert.equal(response.status, 409);
    assert.equal(response.body.code, "VEHICLE_JOB_CLOSED");
    assert.equal(job.status, "COMPLETED");
    assert.equal(ticket.status, "COMPLETED");
    assert.equal(market.status, "COMPLETED");
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number only) cancels the vehicle but preserves an already-completed market and booth (regression: used to overwrite terminal children with updateMany where:{})", async () => {
    const { token: adminToken } = await loginJobAdmin(9912);
    const job = addDispatchableJob(9913, 1);

    const completedTicket = addTicketForTicketJob(job.id, 199130);
    completedTicket.status = "COMPLETED";
    const completedMarket = state.marketJobs.find(
      (item) => item.id === completedTicket.market_job_id,
    )!;
    completedMarket.status = "COMPLETED";

    const activeTicket = addTicketForTicketJob(job.id, 199131, 299131);
    const activeMarket = state.marketJobs.find(
      (item) => item.id === activeTicket.market_job_id,
    )!;

    const response = await server.request("POST", "/api/admin/vehicle-jobs/assignment/cancel", {
      token: adminToken,
      body: { ticket_number: job.ticket_number, reason_code: "test" },
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(job.status, "CANCELLED");
    // Market/Booth ที่ terminal ไปแล้วต้องคงเดิม ห้ามถูกเขียนทับ
    assert.equal(completedTicket.status, "COMPLETED");
    assert.equal(completedMarket.status, "COMPLETED");
    // Market/Booth ที่ยัง active ต้องถูกยกเลิก
    assert.equal(activeTicket.status, "CANCELLED");
    assert.equal(activeMarket.status, "CANCELLED");
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number + ticket_no + boothCode) rolls the market and vehicle up to CANCELLED when it was the only active booth", async () => {
    const { token: adminToken } = await loginJobAdmin(9914);
    const job = addDispatchableJob(9915, 1);
    const ticket = addTicketForTicketJob(job.id, 199150);
    const market = state.marketJobs.find((item) => item.id === ticket.market_job_id)!;

    const response = await server.request("POST", "/api/admin/vehicle-jobs/assignment/cancel", {
      token: adminToken,
      body: {
        ticket_number: job.ticket_number,
        ticket_no: market.ticket_no,
        boothCode: ticket.boothCode,
        reason_code: "test",
      },
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(ticket.status, "CANCELLED");
    assert.equal(market.status, "CANCELLED");
    assert.equal(job.status, "CANCELLED");
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number + ticket_no + boothCode) leaves the vehicle non-terminal when another market is still active", async () => {
    const { token: adminToken } = await loginJobAdmin(9916);
    const job = addDispatchableJob(9917, 1);

    const cancelledTicket = addTicketForTicketJob(job.id, 199170);
    const cancelledMarket = state.marketJobs.find(
      (item) => item.id === cancelledTicket.market_job_id,
    )!;
    const stillActiveTicket = addTicketForTicketJob(job.id, 199171, 299171);

    const response = await server.request("POST", "/api/admin/vehicle-jobs/assignment/cancel", {
      token: adminToken,
      body: {
        ticket_number: job.ticket_number,
        ticket_no: cancelledMarket.ticket_no,
        boothCode: cancelledTicket.boothCode,
        reason_code: "test",
      },
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(cancelledTicket.status, "CANCELLED");
    // Market นี้ไม่มี Booth อื่นเหลือ จึง roll up เป็น CANCELLED เองได้
    assert.equal(cancelledMarket.status, "CANCELLED");
    // Market/Booth อีกใบยัง active อยู่ ห้ามถูกแตะ
    assert.equal(stillActiveTicket.status, "WORKING");
    // รถต้องไม่ถูกปิดก่อนเวลา เพราะยังมีตลาดอื่นทำงานอยู่จริง
    assert.equal(job.status, "WORKING");
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number + ticket_no) rolls the vehicle up to COMPLETED when a sibling market already completed", async () => {
    const { token: adminToken } = await loginJobAdmin(9918);
    const job = addDispatchableJob(9919, 1);

    const completedTicket = addTicketForTicketJob(job.id, 199190);
    completedTicket.status = "COMPLETED";
    const completedMarket = state.marketJobs.find(
      (item) => item.id === completedTicket.market_job_id,
    )!;
    completedMarket.status = "COMPLETED";

    const activeTicket = addTicketForTicketJob(job.id, 199191, 299191);
    const activeMarket = state.marketJobs.find(
      (item) => item.id === activeTicket.market_job_id,
    )!;

    const response = await server.request("POST", "/api/admin/vehicle-jobs/assignment/cancel", {
      token: adminToken,
      body: {
        ticket_number: job.ticket_number,
        ticket_no: activeMarket.ticket_no,
        reason_code: "test",
      },
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(activeMarket.status, "CANCELLED");
    assert.equal(activeTicket.status, "CANCELLED");
    // Market ที่สำเร็จไปแล้วก่อนหน้าต้องไม่ถูกแตะ
    assert.equal(completedMarket.status, "COMPLETED");
    // รถต้องปิดเป็น COMPLETED ไม่ใช่ค้างสถานะเดิมหรือกลายเป็น CANCELLED เพราะมีตลาด COMPLETED อยู่จริง
    assert.equal(job.status, "COMPLETED");
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number + ticket_no + boothCode) triggers a fresh finalize and rolls the market/vehicle up to COMPLETED when a sibling booth in the same market already completed", async () => {
    const { token: adminToken } = await loginJobAdmin(9920);
    const worker = addWorker(9921);
    const job = addDispatchableJob(9922, 1);

    const completedTicket = addTicketForTicketJob(job.id, 199220);
    const market = state.marketJobs.find((item) => item.id === completedTicket.market_job_id)!;

    completedTicket.status = "COMPLETED";
    completedTicket.completed_at = new Date().toISOString();

    const completedProducts = state.ticketProducts.filter(
      (product) => product.ticket_id === completedTicket.id,
    );
    completedProducts[0].confirmed_quantity = "10";
    completedProducts[1].confirmed_quantity = "5";

    state.ticketWorkers.push({
      id: state.nextTicketWorkerId++,
      market_job_id: market.id,
      worker_id: worker.id,
      status: "WORKING",
      joined_at: new Date().toISOString(),
      cancelled_at: null,
      completed_at: null,
    });

    // Booth ที่สองในตลาดเดียวกัน (default marketJobId ผูกกับ ticketJobId เดิม) ยังทำงานอยู่
    const activeTicket = addTicketForTicketJob(job.id, 199221);

    const response = await server.request("POST", "/api/admin/vehicle-jobs/assignment/cancel", {
      token: adminToken,
      body: {
        ticket_number: job.ticket_number,
        ticket_no: market.ticket_no,
        boothCode: activeTicket.boothCode,
        reason_code: "test",
      },
    });

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(activeTicket.status, "CANCELLED");
    // ตลาดต้อง Finalize สดใหม่ (financialized_at ยังไม่เคยมีมาก่อน) แล้วกลายเป็น COMPLETED
    assert.equal(market.status, "COMPLETED");
    assert.ok(market.financialized_at);
    assert.equal(job.status, "COMPLETED");
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number + ticket_no + worker_code) removes the worker from only that Business Ticket's roster, leaving the TicketJobAssignment and the worker's other Business Ticket untouched", async () => {
    const { token: workerToken, worker } = await loginWorker(9601);
    const { token: adminToken } = await loginJobAdmin(9600);

    const job = addDispatchableJob(960, 1);
    const firstTicket = addTicketForTicketJob(job.id, 19601, 296001);
    const secondTicket = addTicketForTicketJob(job.id, 19602, 296002);

    assert.notEqual(firstTicket.market_job_id, secondTicket.market_job_id);

    const firstMarket = state.marketJobs.find((item) => item.id === firstTicket.market_job_id)!;

    const assignment = addPendingAssignment(19603, job.id, worker.id);
    assignment.status = "SCANNED";
    assignment.scanned_at = new Date().toISOString();

    const now = new Date().toISOString();

    state.ticketWorkers.push(
      {
        id: state.nextTicketWorkerId++,
        market_job_id: firstTicket.market_job_id,
        worker_id: worker.id,
        status: "WORKING",
        joined_at: now,
        cancelled_at: null,
        completed_at: null,
      },
      {
        id: state.nextTicketWorkerId++,
        market_job_id: secondTicket.market_job_id,
        worker_id: worker.id,
        status: "WORKING",
        joined_at: now,
        cancelled_at: null,
        completed_at: null,
      }
    );

    const response = await server.request(
      "POST",
      "/api/admin/vehicle-jobs/assignment/cancel",
      {
        token: adminToken,
        body: {
          ticket_number: job.ticket_number,
          ticket_no: firstMarket.ticket_no,
          worker_code: worker.labor_code,
          reason_code: "vendor requested a different worker for this ticket only",
        },
      }
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.status, "CANCELLED");
    assert.equal(response.body.worker_code, worker.labor_code);
    assert.equal(response.body.ticket_number, job.ticket_number);
    assert.equal(response.body.ticket_no, firstMarket.ticket_no);

    const firstTicketWorker = state.ticketWorkers.find(
      (item) =>
        item.market_job_id === firstTicket.market_job_id &&
        item.worker_id === worker.id
    );
    const secondTicketWorker = state.ticketWorkers.find(
      (item) =>
        item.market_job_id === secondTicket.market_job_id &&
        item.worker_id === worker.id
    );

    assert.equal(firstTicketWorker?.status, "CANCELLED");
    assert.ok(firstTicketWorker?.cancelled_at);

    // ต่างจาก Global Cancel: Assignment ระดับรถและ Roster ของ Ticket อื่นต้องไม่ถูกแตะ
    assert.equal(secondTicketWorker?.status, "WORKING");
    assert.equal(secondTicketWorker?.cancelled_at, null);
    assert.equal(assignment.status, "SCANNED");

    // Worker ยังส่งของ Ticket ที่สอง (ที่ยังไม่ถูก Cancel) ได้ตามปกติ
    const secondProducts = state.ticketProducts.filter(
      (product) => product.ticket_id === secondTicket.id
    );
    const secondMarket = state.marketJobs.find((item) => item.id === secondTicket.market_job_id)!;
    const submitResponse = await server.request(
      "POST",
      `/api/workers/me/assignments/tickets/complete`,
      {
        token: workerToken,
        body: {
          ticket_no: secondMarket.ticket_no,
          boothCode: secondTicket.boothCode,
          items: secondProducts.map((product, index) => ({
            productCode: product.productCode,
            packageCode: product.packageCode,
            confirmed_quantity: index === 0 ? 10 : 4,
          })),
        },
      }
    );

    assert.equal(submitResponse.status, 200);
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number + ticket_no + worker_code) returns 404 when the worker is not an active member of that Business Ticket", async () => {
    const { token: adminToken } = await loginJobAdmin(9610);
    const worker = addWorker(9611);

    const job = addDispatchableJob(961, 1);
    const ticket = addTicketForTicketJob(job.id, 19611);
    const market = state.marketJobs.find((item) => item.id === ticket.market_job_id)!;

    const response = await server.request(
      "POST",
      "/api/admin/vehicle-jobs/assignment/cancel",
      {
        token: adminToken,
        body: {
          ticket_number: job.ticket_number,
          ticket_no: market.ticket_no,
          worker_code: worker.labor_code,
          reason_code: "test",
        },
      }
    );

    assert.equal(response.status, 404);
    assert.equal(response.body.code, "TICKET_WORKER_NOT_FOUND");
  });

  // หมายเหตุ: ไม่มี test สำหรับ 409 ASSIGNMENT_NOT_ACTIVE (ทั้ง pre-check ก่อน transaction และ race
  // re-check ในนั้น) เพราะทั้งคู่ unreachable ผ่าน route จริง — findActiveAssignmentByTicketJobRefAndWorkerCode
  // (ทั้งใน src/repositories/admin-jobs.repository.ts ตัวจริงและ mock) กรอง status ใน
  // ACTIVE_ASSIGNMENT_STATUSES ไว้แล้วตั้งแต่ query เอง (`status: { in: ACTIVE_ASSIGNMENT_STATUSES }`)
  // จึงคืนได้แค่ null (-> 404 ASSIGNMENT_NOT_FOUND) หรือ assignment ที่ active อยู่แล้วเท่านั้น — pre-check
  // ที่ line ~2034 ใน cancelAssignment เป็น dead code ที่ไม่มีทาง true ได้ ส่วน race re-check ในทรานแซกชัน
  // ต้องพึ่งอีก request แข่งกันเปลี่ยนสถานะระหว่างเช็คกับเขียนจริง ซึ่ง mock เป็น single-threaded ไม่มี
  // concurrency จริงให้จำลอง Race แบบนี้ได้

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number + ticket_no + boothCode, no worker_code) returns 404 STALL_JOB_NOT_FOUND when the boothCode does not exist under that ticket_no", async () => {
    const { token: adminToken } = await loginJobAdmin(96970);

    const job = addDispatchableJob(96971, 1);
    const market = addMarketJobForVehicle(job.id, {
      id: 396972,
      ticket_no: "TICKET-96971-396972",
      marketCode: "MARKET-96971-A",
    });
    const booth = addTicketForTicketJob(job.id, 496973, market.id);

    const response = await server.request(
      "POST",
      "/api/admin/vehicle-jobs/assignment/cancel",
      {
        token: adminToken,
        body: {
          ticket_number: job.ticket_number,
          ticket_no: market.ticket_no,
          boothCode: "STALL-DOES-NOT-EXIST",
          reason_code: "test",
        },
      },
    );

    assert.equal(response.status, 404);
    assert.equal(response.body.code, "STALL_JOB_NOT_FOUND");
    // Booth ที่มีอยู่จริงของ ticket_no นี้ต้องไม่ถูกแตะเลย
    assert.equal(booth.status, "WORKING");
  });

  test("POST /api/admin/vehicle-jobs/assignment/cancel (ticket_number + ticket_no + boothCode + worker_code) rejects the second exclusion of the same worker from the same booth with 409 WORKER_ALREADY_EXCLUDED_FROM_BOOTH", async () => {
    const { token: adminToken } = await loginJobAdmin(96975);
    const worker = addWorker(96976);

    const job = addDispatchableJob(96977, 1);
    const ticket = addTicketForTicketJob(job.id, 496978);
    const market = state.marketJobs.find((item) => item.id === ticket.market_job_id)!;

    const ticketWorker = {
      id: state.nextTicketWorkerId++,
      market_job_id: ticket.market_job_id,
      worker_id: worker.id,
      status: "WORKING",
      final_earning_amount: null,
      joined_at: new Date().toISOString(),
      cancelled_at: null,
      completed_at: null,
    };
    // Worker อีกคนที่ยังไม่ถูก exclude เลย เพื่อไม่ให้ Booth นี้ถูกยกเลิกอัตโนมัติหลัง exclude ครั้งแรก
    // (คนสุดท้ายที่ถูกถอดออกจาก Booth เท่านั้นที่ trigger auto-cancel ทั้ง Booth — ดู
    // countEligibleWorkersForBooth/remainingEligibleWorkers ใน cancelTicketWorkerFromBooth) ซึ่งไม่ใช่สิ่ง
    // ที่ test นี้ต้องการตรวจ (ต้องการให้ Booth ยังเปิดอยู่ตอนยิง exclude ครั้งที่สอง)
    const decoyWorker = addWorker(96979);
    const decoyTicketWorker = {
      id: state.nextTicketWorkerId++,
      market_job_id: ticket.market_job_id,
      worker_id: decoyWorker.id,
      status: "WORKING",
      final_earning_amount: null,
      joined_at: new Date().toISOString(),
      cancelled_at: null,
      completed_at: null,
    };

    state.ticketWorkers.push(ticketWorker, decoyTicketWorker);

    const requestBody = {
      ticket_number: job.ticket_number,
      ticket_no: market.ticket_no,
      boothCode: ticket.boothCode,
      worker_code: worker.labor_code,
      reason_code: "test",
    };

    const firstResponse = await server.request(
      "POST",
      "/api/admin/vehicle-jobs/assignment/cancel",
      { token: adminToken, body: requestBody },
    );

    assert.equal(firstResponse.status, 200, JSON.stringify(firstResponse.body));

    const exclusionCountAfterFirst = state.boothJobWorkerExclusions.length;

    const secondResponse = await server.request(
      "POST",
      "/api/admin/vehicle-jobs/assignment/cancel",
      { token: adminToken, body: requestBody },
    );

    assert.equal(secondResponse.status, 409);
    assert.equal(secondResponse.body.code, "WORKER_ALREADY_EXCLUDED_FROM_BOOTH");
    // ห้ามมี exclusion record ซ้ำถูกสร้างเพิ่มจากการยิงครั้งที่สอง
    assert.equal(state.boothJobWorkerExclusions.length, exclusionCountAfterFirst);
    assert.equal(ticketWorker.status, "WORKING");
  });
});

describe("Scan Deadline Extend", () => {
  test("POST /api/admin/vehicle-jobs/:ticketNumber/scan-deadline/extend accepts reason_code + reason_text and keeps the existing extend behavior", async () => {
    const { token: adminToken } = await loginJobAdmin(9970);
    const worker = addWorker(9971);
    const job = addDispatchableJob(997, 1);
    const assignment = addPendingAssignment(19970, job.id, worker.id);

    assignment.status = "ACCEPTED";
    assignment.accepted_at = new Date().toISOString();
    const originalScanDeadlineAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    assignment.scan_deadline_at = originalScanDeadlineAt;

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/scan-deadline/extend`,
      {
        token: adminToken,
        body: {
          minutes: 10,
          worker_codes: [worker.labor_code],
          reason_code: "ADMIN_EXTEND_VEHICLE_ASSIGNMENT_SCAN_TIMER",
          reason_text: "ขยายเวลาสแกน QR",
        },
      }
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.ticket_number, job.ticket_number);
    assert.equal(response.body.assignments.length, 1);
    assert.equal(response.body.assignments[0].worker_code, worker.labor_code);
    assert.equal(response.body.assignments[0].status, "ACCEPTED");
    assert.equal(response.body.assignments[0].scan_deadline_at, assignment.scan_deadline_at);
    assert.ok(
      new Date(assignment.scan_deadline_at).getTime() >
        new Date(originalScanDeadlineAt).getTime()
    );

    const queueName = process.env.BULLMQ_ASSIGNMENT_TIMEOUT_QUEUE as string;
    const scanTimeoutJob = state.queueJobs
      .get(queueName)
      ?.get(`assignment-scan-timeout-${assignment.id}`);
    const scanWarningJob = state.queueJobs
      .get(queueName)
      ?.get(`assignment-scan-warning-${assignment.id}`);

    assert.ok(scanTimeoutJob);
    assert.ok(scanWarningJob);

    const extendedEvent = state.realtimeEvents.find(
      (item) => (item as { type?: string }).type === "ASSIGNMENT_SCAN_DEADLINE_EXTENDED"
    );

    assert.ok(extendedEvent);

    const log = state.adminActionLogs.find(
      (item) => item.vehicle_job_id === job.id,
    );

    assert.ok(log);
    assert.equal(log.action_type, "SCAN_DEADLINE_EXTENDED");
    assert.equal(log.reason_code, "ADMIN_EXTEND_VEHICLE_ASSIGNMENT_SCAN_TIMER");
    assert.equal(log.reason_text, "ขยายเวลาสแกน QR");
  });

  test("POST /api/admin/vehicle-jobs/:ticketNumber/scan-deadline/extend rejects reason_text without reason_code", async () => {
    const { token: adminToken } = await loginJobAdmin(9990);
    const worker = addWorker(9991);
    const job = addDispatchableJob(999, 1);
    const assignment = addPendingAssignment(19990, job.id, worker.id);

    assignment.status = "ACCEPTED";
    const originalScanDeadlineAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    assignment.scan_deadline_at = originalScanDeadlineAt;

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/scan-deadline/extend`,
      {
        token: adminToken,
        body: {
          minutes: 10,
          worker_codes: [worker.labor_code],
          reason_text: "ขยายเวลา",
        },
      }
    );

    assert.equal(response.status, 400);
    assert.equal(assignment.scan_deadline_at, originalScanDeadlineAt);
  });

  test("POST /api/admin/vehicle-jobs/:ticketNumber/scan-deadline/extend rejects the legacy reason field alone with 400 (regression: used to validate but silently discard the value, never persisting it anywhere)", async () => {
    const { token: adminToken } = await loginJobAdmin(9925);
    const worker = addWorker(9926);
    const job = addDispatchableJob(9925, 1);
    const assignment = addPendingAssignment(199251, job.id, worker.id);

    assignment.status = "ACCEPTED";
    const originalScanDeadlineAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    assignment.scan_deadline_at = originalScanDeadlineAt;

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/scan-deadline/extend`,
      {
        token: adminToken,
        body: {
          minutes: 10,
          worker_codes: [worker.labor_code],
          reason: "legacy reason field",
        },
      }
    );

    assert.equal(response.status, 400);
    assert.equal(assignment.scan_deadline_at, originalScanDeadlineAt);
  });

  test("POST /api/admin/vehicle-jobs/:ticketNumber/scan-deadline/extend returns 404 ACCEPTED_ASSIGNMENTS_NOT_FOUND when no accepted assignment still has an active scan deadline", async () => {
    const { token: adminToken } = await loginJobAdmin(9927);
    const worker = addWorker(9928);
    const job = addDispatchableJob(9927, 1);
    const assignment = addPendingAssignment(199271, job.id, worker.id);

    // ยัง PENDING (ยังไม่กด Accept เลย) -> ไม่เข้าเงื่อนไข listAcceptedAssignmentsByTicketJob
    assignment.status = "PENDING";
    assignment.scan_deadline_at = null;

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/scan-deadline/extend`,
      {
        token: adminToken,
        body: {
          minutes: 10,
          reason_code: "ADMIN_EXTEND_VEHICLE_ASSIGNMENT_SCAN_TIMER",
        },
      }
    );

    assert.equal(response.status, 404);
    assert.equal(response.body.code, "ACCEPTED_ASSIGNMENTS_NOT_FOUND");
    assert.equal(assignment.scan_deadline_at, null);
    assert.equal(
      state.adminActionLogs.some((item) => item.vehicle_job_id === job.id),
      false,
    );
  });
});

describe("Vehicle Job Operations", () => {
  test("GET /api/admin/vehicle-jobs/operations?status filters by TicketJob.status directly, separate from operation_status", async () => {
    const { token } = await loginJobAdmin(9930);
    const workingJob = addDispatchableJob(993, 1);
    const waitJob = addDispatchableJob(994, 1);
    waitJob.status = "WAIT";

    const response = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/operations?status=WORKING",
      { token },
    );

    assert.equal(response.status, 200);
    const ticketNumbers = response.body.data.map(
      (item: { vehicle_job: { ticket_number: string } }) =>
        item.vehicle_job.ticket_number,
    );

    assert.ok(ticketNumbers.includes(workingJob.ticket_number));
    assert.ok(!ticketNumbers.includes(waitJob.ticket_number));
  });

  test("GET /api/admin/vehicle-jobs/operations?has_issue=true only returns vehicles with at least one REJECT booth", async () => {
    const { token } = await loginJobAdmin(9940);
    const okJob = addDispatchableJob(995, 1);
    addTicketForTicketJob(okJob.id, 19950);

    const issueJob = addDispatchableJob(996, 1);
    const rejectedTicket = addTicketForTicketJob(issueJob.id, 19960);
    rejectedTicket.status = "REJECT";

    const response = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/operations?has_issue=true",
      { token },
    );

    assert.equal(response.status, 200);
    const ticketNumbers = response.body.data.map(
      (item: { vehicle_job: { ticket_number: string } }) =>
        item.vehicle_job.ticket_number,
    );

    assert.ok(ticketNumbers.includes(issueJob.ticket_number));
    assert.ok(!ticketNumbers.includes(okJob.ticket_number));

    const unfilteredResponse = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/operations",
      { token },
    );
    const unfilteredTicketNumbers = unfilteredResponse.body.data.map(
      (item: { vehicle_job: { ticket_number: string } }) =>
        item.vehicle_job.ticket_number,
    );

    assert.ok(unfilteredTicketNumbers.includes(okJob.ticket_number));
    assert.ok(unfilteredTicketNumbers.includes(issueJob.ticket_number));
  });

  test("GET /api/admin/vehicle-jobs/operations?dropoff_point filters to vehicles with at least one matching MarketJob.dropoffPoint, applied before summary/pagination", async () => {
    const { token } = await loginJobAdmin(9942);

    const dockAJob = addDispatchableJob(9943, 1);
    const dockAMarket = addMarketJobForVehicle(dockAJob.id, {
      id: 39430,
      ticket_no: "TICKET-9943-39430",
      marketCode: "MARKET-9943-A",
      dropoff_point: "Dock A1",
    });
    addTicketForTicketJob(dockAJob.id, 49430, dockAMarket.id);

    const dockBJob = addDispatchableJob(9944, 1);
    const dockBMarket = addMarketJobForVehicle(dockBJob.id, {
      id: 39440,
      ticket_no: "TICKET-9944-39440",
      marketCode: "MARKET-9944-A",
      dropoff_point: "Dock B2",
    });
    addTicketForTicketJob(dockBJob.id, 49440, dockBMarket.id);

    const response = await server.request(
      "GET",
      `/api/admin/vehicle-jobs/operations?dropoff_point=${encodeURIComponent("Dock B2")}`,
      { token },
    );

    assert.equal(response.status, 200, JSON.stringify(response.body));
    const ticketNumbers = response.body.data.map(
      (item: { vehicle_job: { ticket_number: string } }) =>
        item.vehicle_job.ticket_number,
    );

    assert.ok(ticketNumbers.includes(dockBJob.ticket_number));
    assert.ok(!ticketNumbers.includes(dockAJob.ticket_number));
    // summary ต้องคำนวณหลังใช้ dropoff_point filter แล้ว (ตรงกับ requirement) — total ต้องเหลือแค่ 1
    assert.equal(response.body.summary.total, 1);
    // available_dropoff_points ต้องเห็นทุกตัวเลือกที่มีจริง (ทั้ง A1 และ B2) แม้กำลังกรองเหลือแค่ B2 อยู่
    // ก็ตาม — ให้ dropdown ยังเสนอตัวเลือกอื่นให้สลับได้เสมอ ไม่ใช่เหลือแค่ตัวที่เลือกไปแล้ว
    assert.deepEqual(
      [...response.body.available_dropoff_points].sort(),
      ["Dock A1", "Dock B2"],
    );

    // ตัวพิมพ์ต่างกันก็ต้อง match ได้ (case-insensitive)
    const lowercaseResponse = await server.request(
      "GET",
      `/api/admin/vehicle-jobs/operations?dropoff_point=${encodeURIComponent("dock b2")}`,
      { token },
    );
    const lowercaseTicketNumbers = lowercaseResponse.body.data.map(
      (item: { vehicle_job: { ticket_number: string } }) =>
        item.vehicle_job.ticket_number,
    );

    assert.ok(lowercaseTicketNumbers.includes(dockBJob.ticket_number));
  });

  test("GET /api/admin/vehicle-jobs/operations?date_from&time_from narrows the range start to that time on date_from, excluding jobs created earlier that day", async () => {
    const { token } = await loginJobAdmin(9950);

    const beforeJob = addDispatchableJob(9951, 1);
    beforeJob.created_at = "2026-07-01T07:00:00.000+07:00";

    const afterJob = addDispatchableJob(9952, 1);
    afterJob.created_at = "2026-07-01T09:00:00.000+07:00";

    const response = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/operations?date_from=2026-07-01&date_to=2026-07-01&time_from=08:00",
      { token },
    );

    assert.equal(response.status, 200, JSON.stringify(response.body));
    const ticketNumbers = response.body.data.map(
      (item: { vehicle_job: { ticket_number: string } }) =>
        item.vehicle_job.ticket_number,
    );

    assert.ok(ticketNumbers.includes(afterJob.ticket_number));
    assert.ok(!ticketNumbers.includes(beforeJob.ticket_number));
  });

  test("GET /api/admin/vehicle-jobs/operations?time_from without date or date_from rejects with 400 VALIDATION_ERROR", async () => {
    const { token } = await loginJobAdmin(9956);

    const response = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/operations?time_from=08:00",
      { token },
    );

    assert.equal(response.status, 400);
    assert.equal(response.body.code, "VALIDATION_ERROR");
  });
});

describe("Financialization Correctness", () => {
  test("worker globally cancelled before Business Ticket roster locks still keeps earnings from an already-completed booth of that ticket", async () => {
    const { token: workerToken, worker } = await loginWorker(9801);
    const { token: replacementToken, worker: replacementWorker } = await loginWorker(9802);
    const { token: adminToken } = await loginJobAdmin(9800);

    const job = addDispatchableJob(980, 1);
    const firstTicket = addTicketForTicketJob(job.id, 19800);
    const secondTicket = addTicketForTicketJob(job.id, 19801);

    // firstTicket / secondTicket ใช้ market_job_id เดียวกัน (Business Ticket ใบเดียว สองแผง)
    assert.equal(firstTicket.market_job_id, secondTicket.market_job_id);
    const sharedMarket = state.marketJobs.find(
      (item) => item.id === firstTicket.market_job_id
    )!;

    // Booth 2 ยังไม่เริ่ม รอ Booth 1 เสร็จก่อน
    secondTicket.status = "WAIT";
    state.marketJobs.find((item) => item.id === firstTicket.market_job_id)!.booth_count = 2;

    const assignment = addPendingAssignment(19802, job.id, worker.id);
    assignment.status = "SCANNED";
    assignment.scanned_at = new Date().toISOString();

    const firstProducts = state.ticketProducts.filter(
      (product) => product.ticket_id === firstTicket.id
    );

    /* -------------------------------------- Complete Booth 1 -------------------------------------- */

    const firstSubmitResponse = await server.request(
      "POST",
      `/api/workers/me/assignments/tickets/complete`,
      {
        token: workerToken,
        body: {
          ticket_no: sharedMarket.ticket_no,
          boothCode: firstTicket.boothCode,
          items: firstProducts.map((product, index) => ({
            productCode: product.productCode,
            packageCode: product.packageCode,
            confirmed_quantity: index === 0 ? 10 : 4,
          })),
        },
      }
    );

    assert.equal(firstSubmitResponse.status, 200);
    assert.equal(firstTicket.status, "DELIVERED");

    workerDispatch.startAssignmentTimeoutProcessing();

    const queueName = process.env.BULLMQ_ASSIGNMENT_TIMEOUT_QUEUE as string;
    const processor = state.workerProcessors.get(queueName);

    assert.ok(processor, "Assignment timeout processor must be registered.");

    const firstSubmission = state.completionSubmissions.at(-1);

    assert.ok(firstSubmission, "First booth completion submission must exist.");

    await processor({
      data: {
        ticketId: firstTicket.id,
        submissionId: firstSubmission.id,
        kind: "vendor_confirm",
      },
    });

    // Booth 1 COMPLETED เองได้ แต่ Business Ticket ห้าม Finalize จนกว่า Booth 2 จะ Terminal ด้วย
    assert.equal(firstTicket.status, "COMPLETED");
    assert.equal(firstTicket.final_stall_amount ?? null, null);
    assert.equal(firstTicket.financialized_at ?? null, null);
    assert.equal(state.ticketProductFinancials.length, 0);
    assert.equal(state.ticketWorkerPayments.length, 0);

    const sharedTicketWorker = state.ticketWorkers.find(
      (ticketWorker) =>
        ticketWorker.market_job_id === firstTicket.market_job_id &&
        ticketWorker.worker_id === worker.id
    );

    assert.ok(sharedTicketWorker);
    // Roster ยังไม่ Lock: worker คนเดิมยังเป็น WORKING แม้ Booth ที่ตัวเองทำจะ COMPLETED แล้ว
    assert.equal(sharedTicketWorker.status, "WORKING");

    /* -------------------------------------- Admin ยกเลิก Worker ทั้ง TicketNumber -------------------------------------- */

    const cancelResponse = await server.request(
      "POST",
      "/api/admin/vehicle-jobs/assignment/cancel",
      {
        token: adminToken,
        body: {
          ticket_number: job.ticket_number,
          worker_code: worker.labor_code,
          reason_code: "replace worker before ticket locks",
        },
      }
    );

    assert.equal(cancelResponse.status, 200);
    assert.equal(assignment.status, "CANCELLED");

    // Ticket ยังไม่ Lock -> Global Cancel ต้อง Cascade มาถอด Roster ของ Ticket นี้ด้วย
    assert.equal(sharedTicketWorker.status, "CANCELLED");
    assert.ok(sharedTicketWorker.cancelled_at);
    assert.equal(sharedTicketWorker.completed_at, null);

    /* -------------------------------------- Admin เพิ่ม Worker ทดแทน -------------------------------------- */

    await workerQueue.enqueueWorker(replacementWorker.id);

    const replacementResponse = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/assign-workers`,
      {
        token: adminToken,
        body: {
          worker_codes: [replacementWorker.labor_code],
          reason_code: "MANUAL_ASSIGNMENT",
        },
      }
    );

    assert.equal(replacementResponse.status, 201);

    const replacementAssignment = state.assignments.find(
      (item) =>
        item.vehicle_job_id === job.id &&
        item.worker_id === replacementWorker.id &&
        item.status === "PENDING"
    );

    assert.ok(replacementAssignment);

    /* -------------------------------------- Complete Booth 2 -------------------------------------- */

    replacementAssignment.status = "SCANNED";
    replacementAssignment.scanned_at = new Date().toISOString();
    secondTicket.status = "WORKING";

    const secondProducts = state.ticketProducts.filter(
      (product) => product.ticket_id === secondTicket.id
    );

    // syncTicketWorkersFromVehicleAssignments เกิดตอน submit นี้เอง เพิ่ม Roster ของ Worker ทดแทน
    const secondSubmitResponse = await server.request(
      "POST",
      `/api/workers/me/assignments/tickets/complete`,
      {
        token: replacementToken,
        body: {
          ticket_no: sharedMarket.ticket_no,
          boothCode: secondTicket.boothCode,
          items: secondProducts.map((product, index) => ({
            productCode: product.productCode,
            packageCode: product.packageCode,
            confirmed_quantity: index === 0 ? 10 : 4,
          })),
        },
      }
    );

    assert.equal(secondSubmitResponse.status, 200);

    const replacementTicketWorker = state.ticketWorkers.find(
      (ticketWorker) =>
        ticketWorker.market_job_id === firstTicket.market_job_id &&
        ticketWorker.worker_id === replacementWorker.id
    );

    assert.ok(replacementTicketWorker);
    assert.equal(secondTicket.status, "DELIVERED");

    const secondSubmission = state.completionSubmissions.at(-1);

    assert.ok(secondSubmission, "Second booth completion submission must exist.");

    await processor({
      data: {
        ticketId: secondTicket.id,
        submissionId: secondSubmission.id,
        kind: "vendor_confirm",
      },
    });

    /* -------------------------------------- ตรวจผล Finalize ทั้ง Ticket -------------------------------------- */

    assert.equal(secondTicket.status, "COMPLETED");
    // ตอนนี้ทั้ง 2 Booth Terminal แล้ว -> Finalize ทั้ง Ticket รวมทั้ง Booth 1 ที่เสร็จไปก่อนหน้า
    assert.ok(firstTicket.final_stall_amount);
    assert.ok(firstTicket.financialized_at);
    assert.ok(secondTicket.final_stall_amount);
    assert.ok(secondTicket.financialized_at);

    // Worker เดิมถูก Cancel ก่อน Lock ของทั้ง Ticket แต่ตอน Booth 1 confirm เขายัง WORKING อยู่จริง ->
    // Snapshot ของ Booth 1 ผูกกับเขาไปแล้ว จึงยังได้เงินจาก Booth 1 (2 products) แม้สถานะ roster
    // สุดท้ายจะเป็น CANCELLED ก็ตาม — นี่คือพฤติกรรมใหม่ที่แก้ให้แฟร์ขึ้น (ไม่ forfeit ย้อนหลัง)
    assert.equal(sharedTicketWorker.status, "CANCELLED");
    assert.ok(sharedTicketWorker.final_earning_amount);
    assert.equal(
      state.ticketWorkerPayments.filter(
        (payment) => payment.ticket_worker_id === sharedTicketWorker.id
      ).length,
      2 // Booth 1 เท่านั้น (2 products)
    );

    // Worker ทดแทนเข้าร่วม roster หลัง Booth 1 confirm ไปแล้ว จึงไม่อยู่ใน Snapshot ของ Booth 1 ->
    // ได้เงินเฉพาะ Booth 2 ที่ตัวเองทำจริงเท่านั้น ไม่ใช่ทั้งสอง Booth เหมือน behavior เดิม
    assert.equal(replacementTicketWorker.status, "COMPLETED");
    assert.ok(replacementTicketWorker.final_earning_amount);
    assert.equal(
      state.ticketWorkerPayments.filter(
        (payment) => payment.ticket_worker_id === replacementTicketWorker.id
      ).length,
      2 // Booth 2 เท่านั้น (2 products)
    );

    /* -------------------------------------- Admin Financial API -------------------------------------- */

    const financialResponse = await server.request(
      "GET",
      `/api/admin/vehicle-jobs/${job.ticket_number}/financials`,
      {
        token: adminToken,
      }
    );

    assert.equal(financialResponse.status, 200);
    assert.equal(financialResponse.body.financial_status, "FINALIZED");
    assert.equal(financialResponse.body.summary.financialized_booth_count, 2);

    const financialFirstBooth = financialResponse.body.booths.find(
      (booth: { ticket_id: number }) => booth.ticket_id === firstTicket.id
    );
    const financialSecondBooth = financialResponse.body.booths.find(
      (booth: { ticket_id: number }) => booth.ticket_id === secondTicket.id
    );

    assert.ok(financialFirstBooth);
    assert.ok(financialSecondBooth);

    const cancelledWorkerInFirstBooth = financialFirstBooth.workers.find(
      (item: { worker_code: string }) => item.worker_code === worker.labor_code
    );
    const replacementWorkerInFirstBooth = financialFirstBooth.workers.find(
      (item: { worker_code: string }) => item.worker_code === replacementWorker.labor_code
    );
    const cancelledWorkerInSecondBooth = financialSecondBooth.workers.find(
      (item: { worker_code: string }) => item.worker_code === worker.labor_code
    );
    const replacementWorkerInSecondBooth = financialSecondBooth.workers.find(
      (item: { worker_code: string }) => item.worker_code === replacementWorker.labor_code
    );

    // Booth 1 (Snapshot = worker เดิมเท่านั้น ตอนนั้น replacement ยังไม่เข้า roster) -> worker เดิมได้
    // เงินจริง แม้ status สุดท้ายจะเป็น CANCELLED, replacement ไม่มีส่วนใน Booth นี้เลย (แสดงเป็น 0
    // เพื่อให้ตรวจสอบได้ว่าเขาไม่ได้ทำ Booth นี้)
    assert.ok(cancelledWorkerInFirstBooth);
    assert.equal(cancelledWorkerInFirstBooth.membership_status, "CANCELLED");
    assert.notEqual(cancelledWorkerInFirstBooth.total_amount, "0.00");

    assert.ok(replacementWorkerInFirstBooth);
    assert.equal(replacementWorkerInFirstBooth.total_amount, "0.00");

    // Booth 2 (Snapshot = worker ทดแทนเท่านั้น ตอนนั้น worker เดิมถูก Cancel ไปแล้ว) -> กลับกัน
    assert.ok(cancelledWorkerInSecondBooth);
    assert.equal(cancelledWorkerInSecondBooth.total_amount, "0.00");

    assert.ok(replacementWorkerInSecondBooth);
    assert.equal(replacementWorkerInSecondBooth.membership_status, "COMPLETED");
    assert.notEqual(replacementWorkerInSecondBooth.total_amount, "0.00");
  });

  // Test เดียวกับตัวอย่างที่คุยกัน: TicketNumber มี 3 ตลาด (3 Business Ticket) ทีมงาน 11 คนถูก dispatch
  // มาทั้งคัน Ticket 1 และ Ticket 2 ทำครบทั้ง 2 แผงด้วยทีม 11 คนเต็ม แต่ Ticket 3 แผง 2 เหลือแค่ 8 คน
  // (Admin ถอน 3 คนออกจาก Roster ของ Ticket 3 นี้โดยเฉพาะ หลังแผง 1 ของ Ticket 3 confirm ไปแล้ว) ->
  // พิสูจน์ว่าแผง 1 ของ Ticket 3 ยังหารด้วย 11 (Snapshot ตอนแผงนั้น confirm) ส่วนแผง 2 หารด้วย 8 จริง
  // และ Admin เห็นรายชื่อ Worker แยกตามแผงได้ว่าใครหายไปจากแผงไหน
  test("financializes each booth of a multi-market TicketNumber against its own worker snapshot, not the vehicle-wide final roster", async () => {
    const { token: submitterToken, worker: submitter } = await loginWorker(8391);
    const { token: adminToken } = await loginJobAdmin(8390);

    const job = addDispatchableJob(1390, 11);

    // ทีมงาน 11 คนถูก Scan เข้าเช็คอินรถคันนี้ทั้งหมด (submitter คนเดียวพอสำหรับยิง API ส่งยอดแทนทีม)
    const teamWorkers = [submitter];

    for (let index = 2; index <= 11; index++) {
      teamWorkers.push(addWorker(8390 + index));
    }

    teamWorkers.forEach((teamWorker, index) => {
      const assignment = addPendingAssignment(19390 + index, job.id, teamWorker.id);

      assignment.status = "SCANNED";
      assignment.scanned_at = new Date().toISOString();
    });

    // TicketNumber นี้มี 3 ตลาด (3 Business Ticket) แต่ละใบมี 2 แผง
    const market1 = addMarketJobForVehicle(job.id, {
      id: 3390,
      ticket_no: "TICKET-1390-3390",
      marketCode: "MARKET-1390-A",
      workers_required: 5,
    });
    const market2 = addMarketJobForVehicle(job.id, {
      id: 3391,
      ticket_no: "TICKET-1390-3391",
      marketCode: "MARKET-1390-B",
      workers_required: 4,
    });
    const market3 = addMarketJobForVehicle(job.id, {
      id: 3392,
      ticket_no: "TICKET-1390-3392",
      marketCode: "MARKET-1390-C",
      workers_required: 2,
    });

    const t1a = addTicketForTicketJob(job.id, 43390, market1.id);
    const t1b = addTicketForTicketJob(job.id, 43391, market1.id);
    const t2a = addTicketForTicketJob(job.id, 43392, market2.id);
    const t2b = addTicketForTicketJob(job.id, 43393, market2.id);
    const t3a = addTicketForTicketJob(job.id, 43394, market3.id);
    const t3b = addTicketForTicketJob(job.id, 43395, market3.id);

    workerDispatch.startAssignmentTimeoutProcessing();

    const queueName = process.env.BULLMQ_ASSIGNMENT_TIMEOUT_QUEUE as string;
    const processor = state.workerProcessors.get(queueName);

    assert.ok(processor, "Assignment timeout processor must be registered.");

    // Function ช่วยส่งยอด + ให้ vendor confirm หนึ่งแผง (submitter คนเดียวยิงแทนทีมทั้งหมด)
    const submitAndConfirmBooth = async (
      ticket: ReturnType<typeof addTicketForTicketJob>,
      marketJob: ReturnType<typeof addMarketJobForVehicle>
    ) => {
      const products = state.ticketProducts.filter(
        (product) => product.ticket_id === ticket.id
      );

      const submitResponse = await server.request(
        "POST",
        `/api/workers/me/assignments/tickets/complete`,
        {
          token: submitterToken,
          body: {
            ticket_no: marketJob.ticket_no,
            boothCode: ticket.boothCode,
            // Quantity ใหญ่กว่าปกติ (ทีมงาน 11 คนใน test นี้) เพื่อให้ค่าแรงต่อคนหลังหารแล้วไม่ปัดลงเป็น 0
            // บาทจนแยกไม่ออกว่า "อยู่ใน Snapshot แต่ได้ 0 พอดี" กับ "ไม่อยู่ใน Snapshot เลย"
            items: products.map((product, index) => ({
              productCode: product.productCode,
              packageCode: product.packageCode,
              confirmed_quantity: index === 0 ? 110 : 44,
            })),
          },
        }
      );

      assert.equal(submitResponse.status, 200);

      const submission = state.completionSubmissions.at(-1)!;

      await processor({
        data: {
          ticketId: ticket.id,
          submissionId: submission.id,
          kind: "vendor_confirm",
        },
      });
    };

    /* -------------------------------------- Ticket 1: ทั้ง 2 แผงทำครบด้วยทีม 11 คน -------------------------------------- */

    await submitAndConfirmBooth(t1a, market1);
    await submitAndConfirmBooth(t1b, market1);

    assert.ok(market1.financialized_at);
    assert.ok(market1.worker_roster_locked_at);

    /* -------------------------------------- Ticket 2: ทั้ง 2 แผงทำครบด้วยทีม 11 คน -------------------------------------- */

    await submitAndConfirmBooth(t2a, market2);
    await submitAndConfirmBooth(t2b, market2);

    assert.ok(market2.financialized_at);
    assert.ok(market2.worker_roster_locked_at);

    /* -------------------------------------- Ticket 3 แผง 1: ยังเป็นทีม 11 คนเต็ม -------------------------------------- */

    await submitAndConfirmBooth(t3a, market3);

    // Ticket 3 ยัง Finalize ไม่ได้ เพราะแผง 2 ยังไม่ Terminal
    assert.equal(market3.financialized_at ?? null, null);

    /* -------------------------------------- Admin ถอน worker 3 คนออกจาก Ticket 3 นี้เท่านั้น -------------------------------------- */

    // เว้น submitter (index 0) ไว้ ไม่ถอนออก เพราะยังต้องใช้ยิง API ส่งยอดแผง 2 ต่อ
    const droppedWorkers = teamWorkers.slice(1, 4);

    for (const droppedWorker of droppedWorkers) {
      const cancelResponse = await server.request(
        "POST",
        "/api/admin/vehicle-jobs/assignment/cancel",
        {
          token: adminToken,
          body: {
            ticket_number: job.ticket_number,
            ticket_no: market3.ticket_no,
            worker_code: droppedWorker.labor_code,
            reason_code: "reassigned to another Business Ticket of the same truck",
          },
        }
      );

      assert.equal(cancelResponse.status, 200);
    }

    // ทั้ง 11 คนยัง Scan เช็คอินอยู่บนรถเหมือนเดิม (ไม่ได้ถูกถอน Assignment ระดับรถ) แค่ถูกถอนออกจาก
    // Roster ของ Ticket 3 นี้เท่านั้น ทีมงานยังส่งยอดแผงถัดไปของ Ticket 3 ได้ตามปกติ ไม่ติด
    // WORKERS_NOT_CHECKED_IN

    /* -------------------------------------- Ticket 3 แผง 2: เหลือ 8 คน -------------------------------------- */

    await submitAndConfirmBooth(t3b, market3);

    assert.ok(market3.financialized_at);
    assert.ok(market3.worker_roster_locked_at);

    /* -------------------------------------- ตรวจ worker_count ที่บันทึกไว้ต่อแผง -------------------------------------- */

    const boothOneFinancials = state.ticketProducts
      .filter((product) => product.ticket_id === t3a.id)
      .map(
        (product) =>
          state.ticketProductFinancials.find(
            (financial) => financial.ticket_product_id === product.id
          )!
      );
    const boothTwoFinancials = state.ticketProducts
      .filter((product) => product.ticket_id === t3b.id)
      .map(
        (product) =>
          state.ticketProductFinancials.find(
            (financial) => financial.ticket_product_id === product.id
          )!
      );

    assert.equal(boothOneFinancials.length, 2);
    assert.equal(boothTwoFinancials.length, 2);

    for (const financial of boothOneFinancials) {
      assert.ok(financial);
      assert.equal(financial.worker_count, 11);
    }

    for (const financial of boothTwoFinancials) {
      assert.ok(financial);
      assert.equal(financial.worker_count, 8);
    }

    /* -------------------------------------- ตรวจว่า worker ที่ถูกถอนยังได้เงินจากแผง 1 แต่ไม่ได้จากแผง 2 -------------------------------------- */

    const boothOneFinancialIds = boothOneFinancials.map((financial) => financial.id);
    const boothTwoFinancialIds = boothTwoFinancials.map((financial) => financial.id);

    for (const droppedWorker of droppedWorkers) {
      const ticketWorker = state.ticketWorkers.find(
        (item) =>
          item.market_job_id === market3.id &&
          item.worker_id === droppedWorker.id
      )!;

      assert.ok(ticketWorker);
      assert.equal(ticketWorker.status, "CANCELLED");
      // ยังได้เงินจากแผง 1 ที่ทำไปจริงตอนยัง WORKING อยู่ ไม่ถูกริบย้อนหลัง
      assert.ok(ticketWorker.final_earning_amount);

      const paymentsForBoothOne = state.ticketWorkerPayments.filter(
        (payment) =>
          payment.ticket_worker_id === ticketWorker.id &&
          boothOneFinancialIds.includes(payment.ticket_product_financial_id)
      );
      const paymentsForBoothTwo = state.ticketWorkerPayments.filter(
        (payment) =>
          payment.ticket_worker_id === ticketWorker.id &&
          boothTwoFinancialIds.includes(payment.ticket_product_financial_id)
      );

      assert.equal(paymentsForBoothOne.length, 2); // 2 products ของแผง 1
      assert.equal(paymentsForBoothTwo.length, 0); // ไม่มีส่วนในแผง 2 เลย เพราะไม่ได้อยู่ใน Snapshot
    }

    // 8 คนที่เหลือต้องได้เงินจากทั้งสองแผง (แผงละ 2 products = รวม 4 payment ต่อคน)
    const remainingWorkers = teamWorkers.filter(
      (teamWorker) => !droppedWorkers.includes(teamWorker)
    );

    for (const remainingWorker of remainingWorkers) {
      const ticketWorker = state.ticketWorkers.find(
        (item) =>
          item.market_job_id === market3.id &&
          item.worker_id === remainingWorker.id
      )!;

      assert.ok(ticketWorker);
      assert.equal(ticketWorker.status, "COMPLETED");

      const totalPayments = state.ticketWorkerPayments.filter(
        (payment) => payment.ticket_worker_id === ticketWorker.id
      );

      assert.equal(totalPayments.length, 4);
    }

    /* -------------------------------------- Admin Financial API: ต้องแยกรายแผงได้ว่าใครหายไปจากแผงไหน -------------------------------------- */

    const financialResponse = await server.request(
      "GET",
      `/api/admin/vehicle-jobs/${job.ticket_number}/financials`,
      {
        token: adminToken,
      }
    );

    assert.equal(financialResponse.status, 200);

    const financialBoothOne = financialResponse.body.booths.find(
      (booth: { ticket_id: number }) => booth.ticket_id === t3a.id
    );
    const financialBoothTwo = financialResponse.body.booths.find(
      (booth: { ticket_id: number }) => booth.ticket_id === t3b.id
    );

    assert.ok(financialBoothOne);
    assert.ok(financialBoothTwo);

    for (const droppedWorker of droppedWorkers) {
      const rowInBoothOne = financialBoothOne.workers.find(
        (item: { worker_code: string }) => item.worker_code === droppedWorker.labor_code
      );
      const rowInBoothTwo = financialBoothTwo.workers.find(
        (item: { worker_code: string }) => item.worker_code === droppedWorker.labor_code
      );

      // แผง 1: เขายังทำงานอยู่ตอนนั้น -> ได้เงินจริง
      assert.ok(rowInBoothOne);
      assert.notEqual(rowInBoothOne.total_amount, "0.00");

      // แผง 2: ถูกถอนไปก่อนแล้ว -> เห็นชื่อได้เพื่อตรวจสอบ แต่ total_amount ต้องเป็น 0 ชัดเจนว่า "หายไป"
      assert.ok(rowInBoothTwo);
      assert.equal(rowInBoothTwo.total_amount, "0.00");
    }

    for (const remainingWorker of remainingWorkers) {
      const rowInBoothTwo = financialBoothTwo.workers.find(
        (item: { worker_code: string }) => item.worker_code === remainingWorker.labor_code
      );

      assert.ok(rowInBoothTwo);
      assert.notEqual(rowInBoothTwo.total_amount, "0.00");
    }
  });

  test("ticket financialization keeps Gate rate snapshot after MasterRate changes", async () => {
    const { token: workerToken, worker } =
      await loginWorker(9901);

    const { token: adminToken } =
      await loginJobAdmin(9900);

    /* -------------------------------------- Gate Create -------------------------------------- */

    const gateBody =
      buildBoothJobJobBody("001");

    /*
     * Gate Quantity intentionally = 1
     *
     *เน€เธเธดเธเธเธฃเธดเธเธ เธฒเธขเธซเธฅเธฑเธเธเธฐเนเธเน confirmed_quantity = 10
     * เน€เธเธทเนเธญเธขเธทเธเธขเธฑเธเธงเนเธฒ Financialization เนเธกเนเนเธเน Gate quantity
     */
    gateBody.Booths[0].Products[0].Quantity = 1;

    const gateResponse =
      await server.request(
        "POST",
        "/api/gate/tickets",
        {
          body: gateBody,
          headers:
            await gateAuthHeaders(),
        }
      );

    assert.equal(
      gateResponse.status,
      201
    );

    assert.equal(
      gateResponse.body.WorkerCount,
      1
    );

    const job =
      state.ticketJobs.find(
        (item) =>
          item.ticket_number ===
          gateBody.TicketNumber
      );

    assert.ok(job);

    const ticket =
      state.boothJobs.find(
        (item) =>
          item.vehicle_job_id ===
          job.id
      );

    assert.ok(ticket);

    const product =
      state.ticketProducts.find(
        (item) =>
          item.ticket_id ===
          ticket.id
      );

    assert.ok(product);

    /* -------------------------------------- เธ•เธฃเธงเธ Snapshot เธ•เธญเธ Gate Create -------------------------------------- */

    assert.equal(
      product.quantity,
      "1"
    );

    assert.equal(
      product.confirmed_quantity,
      null
    );

    assert.equal(
      product.rate_market_code,
      "0000"
    );

    assert.equal(
      product.rate_source,
      "CENTRAL_RATE"
    );

    assert.equal(
      product.stall_rate_snapshot,
      "1.5"
    );

    assert.equal(
      product.labor_rate_snapshot,
      "0.9"
    );

    assert.ok(
      product.rate_snapshot_at
    );

    const snapshotAt =
      product.rate_snapshot_at;

    /* -------------------------------------- เน€เธเธฅเธตเนเธขเธ Master Rate เธซเธฅเธฑเธ Gate Create -------------------------------------- */

    const centralRate =
      state.masterRates.find(
        (rate) =>
          rate.marketCode === "0000" &&
          rate.id === 1
      );

    assert.ok(centralRate);

    centralRate.stallRate =
      centralRate.stallRate.plus(
        "997.5"
      );

    centralRate.laborRate =
      centralRate.laborRate.plus(
        "998.1"
      );

    // Master เธเธฑเธเธเธธเธเธฑเธเน€เธเธฅเธตเนเธขเธเน€เธเนเธ 999 เนเธฅเนเธงเธเธฃเธดเธ
    assert.equal(
      centralRate.stallRate.toString(),
      "999"
    );

    assert.equal(
      centralRate.laborRate.toString(),
      "999"
    );

    // เนเธ•เน Snapshot เธเธญเธ TicketProduct เธ•เนเธญเธเนเธกเนเน€เธเธฅเธตเนเธขเธ
    assert.equal(
      product.stall_rate_snapshot,
      "1.5"
    );

    assert.equal(
      product.labor_rate_snapshot,
      "0.9"
    );

    assert.equal(
      product.rate_snapshot_at,
      snapshotAt
    );

    /* -------------------------------------- Worker Assignment -------------------------------------- */

    const assignment =
      addPendingAssignment(
        19901,
        job.id,
        worker.id
      );

    assignment.status = "SCANNED";
    assignment.scanned_at =
      new Date().toISOString();

    /* -------------------------------------- Submit Actual Quantity -------------------------------------- */

    const submitResponse =
      await server.request(
        "POST",
        `/api/workers/me/assignments/tickets/complete`,
        {
          token:
            workerToken,

          body: {
            ticket_no:
              gateBody.TicketNo,

            boothCode:
              ticket.boothCode,

            items: [
              {
                productCode:
                  product.productCode,

                packageCode:
                  product.packageCode,

                confirmed_quantity:
                  10,
              },
            ],
          },
        }
      );

    assert.equal(
      submitResponse.status,
      200
    );

    assert.equal(
      ticket.status,
      "DELIVERED"
    );

    // Actual = 10 เนเธกเน Gate Quantity = 1
    assert.equal(
      product.confirmed_quantity,
      "10"
    );

    /* -------------------------------------- Vendor Auto Confirm -------------------------------------- */

    workerDispatch
      .startAssignmentTimeoutProcessing();

    const queueName =
      process.env
        .BULLMQ_ASSIGNMENT_TIMEOUT_QUEUE as string;

    const processor =
      state.workerProcessors.get(
        queueName
      );

    assert.ok(
      processor,
      "Assignment timeout processor must be registered."
    );

    const submission =
      state.completionSubmissions.at(-1);

    assert.ok(
      submission,
      "Completion submission must exist."
    );

    await processor({
      data: {
        ticketId:
          ticket.id,

        submissionId:
          submission.id,

        kind:
          "vendor_confirm",
      },
    });

    /* -------------------------------------- เธ•เธฃเธงเธ Financial Result -------------------------------------- */

    assert.equal(
      ticket.status,
      "COMPLETED"
    );

    assert.ok(
      ticket.financialized_at
    );

    assert.equal(
      ticket.final_stall_amount,
      "24.00"
    );

    assert.equal(
      state.ticketProductFinancials.length,
      1
    );

    assert.equal(
      state.ticketWorkerPayments.length,
      1
    );

    const financial =
      state.ticketProductFinancials[0];

    /*
     * เธ•เนเธญเธเน€เธเนเธเธเธฅเธเธฒเธ Snapshot:
     *
     * confirmed = 10
     * stallRate = 1.50
     * laborRate = 0.90
     *
     * StallRaw = 15
     * LaborRaw = 9
     * ProductCharge = 24
     */
    assert.equal(
      financial.confirmed_quantity,
      "10"
    );

    assert.equal(
      financial.stall_fee_raw,
      "15"
    );

    assert.equal(
      financial.stall_fee_rounded,
      "15"
    );

    assert.equal(
      financial.labor_fee_raw,
      "9"
    );

    assert.equal(
      financial.product_charge,
      "24"
    );

    assert.equal(
      financial.worker_count,
      1
    );

    assert.equal(
      financial.worker_payout_total,
      "9"
    );

    assert.equal(
      financial.fund_amount,
      "0"
    );

    const payment =
      state.ticketWorkerPayments[0];

    assert.equal(
      payment.raw_amount,
      "9"
    );

    assert.equal(
      payment.final_amount,
      "9"
    );

    assert.equal(
      payment.remainder_amount,
      "0"
    );

    /* -------------------------------------- Snapshot เธ•เนเธญเธเธขเธฑเธเน€เธซเธกเธทเธญเธเน€เธ”เธดเธกเธซเธฅเธฑเธ Financialize -------------------------------------- */

    assert.equal(
      product.stall_rate_snapshot,
      "1.5"
    );

    assert.equal(
      product.labor_rate_snapshot,
      "0.9"
    );

    assert.equal(
      product.rate_snapshot_at,
      snapshotAt
    );

    // Master เธขเธฑเธเน€เธเนเธ 999 เน€เธเธทเนเธญเธขเธทเธเธขเธฑเธเธงเนเธฒเนเธกเนเนเธ”เน revert เธเธฅเธฑเธ
    assert.equal(
      centralRate.stallRate.toString(),
      "999"
    );

    assert.equal(
      centralRate.laborRate.toString(),
      "999"
    );

    /* -------------------------------------- Admin Financial API -------------------------------------- */

    const financialResponse =
      await server.request(
        "GET",
        `/api/admin/vehicle-jobs/${job.ticket_number}/financials`,
        {
          token:
            adminToken,
        }
      );

    assert.equal(
      financialResponse.status,
      200
    );

    assert.equal(
      financialResponse.body
        .financial_status,
      "FINALIZED"
    );

    assert.deepEqual(
      financialResponse.body.summary,
      {
        booth_count:
          1,

        financialized_booth_count:
          1,

        final_stall_amount:
          "24.00",

        labor_fee_raw:
          "9.0000",

        worker_payout_total:
          "9.00",

        fund_amount:
          "0.0000",
      }
    );

    const financialProduct =
      financialResponse.body
        .booths[0]
        .products[0];

    // API เธ•เนเธญเธเธฃเธฒเธขเธเธฒเธ Snapshot เน€เธ”เธดเธก เนเธกเนเนเธเน Master 999
    assert.equal(
      financialProduct
        .rate_snapshot
        .stall_rate_snapshot,
      "1.50"
    );

    assert.equal(
      financialProduct
        .rate_snapshot
        .labor_rate_snapshot,
      "0.90"
    );

    assert.equal(
      financialProduct
        .confirmed_quantity,
      "10.00"
    );

    assert.equal(
      financialProduct
        .financial
        .stall_fee_raw,
      "15.0000"
    );

    assert.equal(
      financialProduct
        .financial
        .labor_fee_raw,
      "9.0000"
    );

    assert.equal(
      financialProduct
        .financial
        .product_charge,
      "24.00"
    );

    assert.equal(
      financialProduct
        .financial
        .worker_payout_total,
      "9.00"
    );

    assert.equal(
      financialProduct
        .financial
        .fund_amount,
      "0.0000"
    );
  });

  test("ticket financialization rejects partial financial state without overwriting persisted money", async () => {
    const worker = addWorker(9951);

    const job = addDispatchableJob(
      995,
      1
    );

    const ticket =
      addTicketForTicketJob(
        job.id,
        19950
      );

    const products =
      state.ticketProducts.filter(
        (product) =>
          product.ticket_id ===
          ticket.id
      );

    assert.equal(
      products.length,
      2
    );

    const financializedAttemptAt =
      "2026-08-09T08:00:00.000Z";

    /* -------------------------------------- เน€เธ•เธฃเธตเธขเธก Ticket เธชเธณเธซเธฃเธฑเธ Financialize -------------------------------------- */

    ticket.status = "COMPLETED";
    ticket.confirmation_status = "COMPLETED";
    ticket.completed_at =
      financializedAttemptAt;

    ticket.final_stall_amount = null;
    ticket.financialized_at = null;

    job.status = "WORKING";

    /* -------------------------------------- Confirmed Quantity + Snapshot เธเธฃเธ -------------------------------------- */

    products.forEach(
      (product, index) => {
        product.confirmed_quantity =
          index === 0
            ? "10"
            : "4";

        product.package_weight_snapshot =
          "20";

        product.rate_id_snapshot =
          1;

        product.source_rate_id_snapshot =
          1;

        product.rate_market_code =
          "0000";

        product.rate_source =
          "CENTRAL_RATE";

        product.weight_range_name =
          "1-25.0";

        product.weight_min_snapshot =
          "0";

        product.weight_max_snapshot =
          "25";

        product.stall_rate_snapshot =
          "1.5";

        product.labor_rate_snapshot =
          "0.9";

        product.rate_snapshot_at =
          financializedAttemptAt;
      }
    );

    /* -------------------------------------- Completed Worker -------------------------------------- */

    const ticketWorker = {
      id:
        state.nextTicketWorkerId++,

      market_job_id:
        ticket.market_job_id,

      worker_id:
        worker.id,

      status:
        "COMPLETED",

      joined_at:
        financializedAttemptAt,

      cancelled_at:
        null,

      completed_at:
        financializedAttemptAt,
    };

    state.ticketWorkers.push(
      ticketWorker
    );

    /* -------------------------------------- เธเธณเธฅเธญเธ Corrupted Partial State -------------------------------------- */

    /*
     * Product 1 เธกเธต Financial เธญเธขเธนเนเนเธฅเนเธง
     * เนเธ•เน Ticket เธขเธฑเธเนเธกเนเธกเธต financialized_at
     *
     * Product 2 เธขเธฑเธเนเธกเนเธกเธต Financial
     */
    const existingFinancial = {
      id:
        state
          .nextTicketProductFinancialId++,

      ticket_product_id:
        products[0].id,

      confirmed_quantity:
        "10",

      stall_fee_raw:
        "15",

      stall_fee_rounded:
        "15",

      labor_fee_raw:
        "9",

      product_charge:
        "24",

      worker_count:
        1,

      worker_payout_total:
        "9",

      fund_amount:
        "0",

      finalized_at:
        financializedAttemptAt,
    };

    state.ticketProductFinancials.push(
      existingFinancial
    );

    const existingPayment = {
      id:
        state
          .nextTicketWorkerPaymentId++,

      ticket_product_financial_id:
        existingFinancial.id,

      ticket_worker_id:
        ticketWorker.id,

      raw_amount:
        "9",

      remainder_amount:
        "0",

      final_amount:
        "9",
    };

    state.ticketWorkerPayments.push(
      existingPayment
    );

    /* -------------------------------------- Snapshot State เธเนเธญเธ Finalize -------------------------------------- */

    const financialBefore = {
      ...existingFinancial,
    };

    const paymentBefore = {
      ...existingPayment,
    };

    const financialCountBefore =
      state.ticketProductFinancials.length;

    const paymentCountBefore =
      state.ticketWorkerPayments.length;

    assert.equal(
      financialCountBefore,
      1
    );

    assert.equal(
      paymentCountBefore,
      1
    );

    assert.equal(
      state.ticketProductFinancials.some(
        (financial) =>
          financial.ticket_product_id ===
          products[1].id
      ),
      false
    );

    /* -------------------------------------- Attempt 1 -------------------------------------- */

    await assert.rejects(
      () =>
        ticketFinancialService
          .finalizeMarketJobFinancials(
            ticket.market_job_id
          ),

      (error) =>
        Boolean(
          error &&
          typeof error === "object" &&
          (
            error as {
              statusCode?: number;
              code?: string;
            }
          ).statusCode === 500 &&
          (
            error as {
              statusCode?: number;
              code?: string;
            }
          ).code ===
          "TICKET_FINANCIAL_PARTIAL_STATE"
        )
    );

    /* -------------------------------------- เธซเนเธฒเธกเน€เธเธตเธขเธเน€เธเธดเนเธก / เธซเนเธฒเธกเนเธเนเธเธญเธเน€เธ”เธดเธก -------------------------------------- */

    assert.equal(
      state.ticketProductFinancials.length,
      financialCountBefore
    );

    assert.equal(
      state.ticketWorkerPayments.length,
      paymentCountBefore
    );

    assert.deepEqual(
      state.ticketProductFinancials[0],
      financialBefore
    );

    assert.deepEqual(
      state.ticketWorkerPayments[0],
      paymentBefore
    );

    // Product 2 เธซเนเธฒเธกเธ–เธนเธเธชเธฃเนเธฒเธ Financial
    assert.equal(
      state.ticketProductFinancials.some(
        (financial) =>
          financial.ticket_product_id ===
          products[1].id
      ),
      false
    );

    // Ticket marker เธซเนเธฒเธกเธ–เธนเธเน€เธเธตเธขเธ
    assert.equal(
      ticket.final_stall_amount,
      null
    );

    assert.equal(
      ticket.financialized_at,
      null
    );

    /* -------------------------------------- Attempt 2 เธ•เนเธญเธเธขเธฑเธ Reject เน€เธซเธกเธทเธญเธเน€เธ”เธดเธก -------------------------------------- */

    await assert.rejects(
      () =>
        ticketFinancialService
          .finalizeMarketJobFinancials(
            ticket.market_job_id
          ),

      (error) =>
        Boolean(
          error &&
          typeof error === "object" &&
          (
            error as {
              statusCode?: number;
              code?: string;
            }
          ).statusCode === 500 &&
          (
            error as {
              statusCode?: number;
              code?: string;
            }
          ).code ===
          "TICKET_FINANCIAL_PARTIAL_STATE"
        )
    );

    // เธฅเธญเธเธเนเธณเธเนเธขเธฑเธเธซเนเธฒเธกเน€เธเธดเนเธก record
    assert.equal(
      state.ticketProductFinancials.length,
      financialCountBefore
    );

    assert.equal(
      state.ticketWorkerPayments.length,
      paymentCountBefore
    );

    assert.deepEqual(
      state.ticketProductFinancials[0],
      financialBefore
    );

    assert.deepEqual(
      state.ticketWorkerPayments[0],
      paymentBefore
    );

    assert.equal(
      ticket.final_stall_amount,
      null
    );

    assert.equal(
      ticket.financialized_at,
      null
    );
  });
});

// describe นี้ทดสอบ guard เงินภายใน ticketFinancialService.finalizeMarketJobFinancials ตรงๆ (ไม่ผ่าน HTTP
// route) เหมือน pattern "ticket financialization rejects partial financial state..." ด้านบน เพราะ caller
// เดียวที่เรียกฟังก์ชันนี้จริง (closeCompletedTicketJobIfReady ใน ticket-job-lifecycle.service.ts) เช็ค
// precondition ส่วนใหญ่ไว้ก่อนแล้วเสมอในทรานแซกชันเดียวกัน ทำให้ trigger จาก route จริงตรงๆ ไม่ได้ (หรือทำได้
// ยากมากจนต้องปลอม state จนแทบไม่ต่างจากเรียกฟังก์ชันตรงๆ อยู่ดี)
describe("Ticket Financial Guards", () => {
  test("finalizeMarketJobFinancials rejects with 409 MARKET_JOB_NOT_READY_FOR_FINANCIALIZE when not every booth of the business ticket is terminal yet", async () => {
    const job = addDispatchableJob(99100, 1);
    const ticket = addTicketForTicketJob(job.id, 199101);
    const market = state.marketJobs.find((item) => item.id === ticket.market_job_id)!;

    // ticket.status ยังเป็น "WORKING" ค่า default จาก fixture (ไม่ terminal เลย)
    assert.equal(ticket.status, "WORKING");

    await assertFinalizeRejects(market.id, 409, "MARKET_JOB_NOT_READY_FOR_FINANCIALIZE");

    assert.equal(market.financialized_at, null);
    assert.equal(ticket.final_stall_amount ?? null, null);
    assert.equal(state.ticketProductFinancials.length, 0);
  });

  test("finalizeMarketJobFinancials rejects with 409 TICKET_PRODUCTS_NOT_FOUND when the only completed booth has no products", async () => {
    const job = addDispatchableJob(99102, 1);
    const ticket = addTicketForTicketJob(job.id, 199103);
    const market = state.marketJobs.find((item) => item.id === ticket.market_job_id)!;

    ticket.status = "COMPLETED";
    ticket.confirmation_status = "COMPLETED";
    ticket.completed_at = new Date().toISOString();
    // Booth นี้ไม่มี Product เลย (เช่น Gate ส่ง Booth มาแบบไม่มีรายการสินค้า)
    state.ticketProducts = state.ticketProducts.filter(
      (product) => product.ticket_id !== ticket.id,
    );

    await assertFinalizeRejects(market.id, 409, "TICKET_PRODUCTS_NOT_FOUND");

    assert.equal(market.financialized_at, null);
    assert.equal(ticket.final_stall_amount ?? null, null);
    assert.equal(state.ticketProductFinancials.length, 0);
  });

  test("finalizeMarketJobFinancials rejects with 409 TICKET_WORKERS_NOT_FOUND when the business ticket roster has no WORKING worker at all", async () => {
    const job = addDispatchableJob(99104, 1);
    const ticket = addTicketForTicketJob(job.id, 199105);
    const market = state.marketJobs.find((item) => item.id === ticket.market_job_id)!;

    ticket.status = "COMPLETED";
    ticket.confirmation_status = "COMPLETED";
    ticket.completed_at = new Date().toISOString();
    // ไม่สร้าง TicketWorker ให้ market นี้เลยสักคน

    await assertFinalizeRejects(market.id, 409, "TICKET_WORKERS_NOT_FOUND");

    assert.equal(market.financialized_at, null);
    assert.equal(ticket.final_stall_amount ?? null, null);
    assert.equal(state.ticketProductFinancials.length, 0);
  });

  test("finalizeMarketJobFinancials rejects with 409 TICKET_WORKERS_NOT_FOUND when a specific booth's worker snapshot references a worker no longer on the roster (data-integrity edge case)", async () => {
    const worker = addWorker(99106);
    const job = addDispatchableJob(99107, 1);
    const ticket = addTicketForTicketJob(job.id, 199108);
    const market = state.marketJobs.find((item) => item.id === ticket.market_job_id)!;

    ticket.status = "COMPLETED";
    ticket.confirmation_status = "COMPLETED";
    ticket.completed_at = new Date().toISOString();

    // "keeper": ยังอยู่ใน roster จริง WORKING -> ทำให้ actualWorkerCount (เช็คระดับทั้ง Business Ticket)
    // ผ่าน ไม่ throw ที่ guard ก่อนหน้า (TICKET_WORKERS_NOT_FOUND ระดับ market-wide)
    const keeper = {
      id: state.nextTicketWorkerId++,
      market_job_id: market.id,
      worker_id: worker.id,
      status: "WORKING",
      final_earning_amount: null,
      joined_at: new Date().toISOString(),
      cancelled_at: null,
      completed_at: null,
    };

    state.ticketWorkers.push(keeper);

    // Snapshot ของ Booth นี้อ้างถึง ticket_worker_id ที่ไม่มีอยู่จริงใน roster เลย (ไม่ควรเกิดขึ้นได้จาก
    // flow ปกติ เพราะ TicketWorker ไม่เคยถูกลบจริง แค่เปลี่ยน status — จำลอง data-integrity edge case
    // ที่ guard นี้มีไว้ป้องกัน)
    state.boothJobWorkerSnapshots.push({
      id: state.nextBoothJobWorkerSnapshotId++,
      gate_ticket_id: ticket.id,
      ticket_worker_id: 9_999_999,
      created_at: new Date().toISOString(),
    });

    await assertFinalizeRejects(market.id, 409, "TICKET_WORKERS_NOT_FOUND");

    assert.equal(market.financialized_at, null);
    assert.equal(ticket.final_stall_amount ?? null, null);
    assert.equal(state.ticketProductFinancials.length, 0);
  });

  test("finalizeMarketJobFinancials rejects with 409 CONFIRMED_QUANTITY_MISSING when a completed booth's product never received a confirmed quantity", async () => {
    const worker = addWorker(99109);
    const job = addDispatchableJob(99110, 1);
    const ticket = addTicketForTicketJob(job.id, 199111);
    const market = state.marketJobs.find((item) => item.id === ticket.market_job_id)!;

    ticket.status = "COMPLETED";
    ticket.confirmation_status = "COMPLETED";
    ticket.completed_at = new Date().toISOString();

    state.ticketWorkers.push({
      id: state.nextTicketWorkerId++,
      market_job_id: market.id,
      worker_id: worker.id,
      status: "WORKING",
      final_earning_amount: null,
      joined_at: new Date().toISOString(),
      cancelled_at: null,
      completed_at: null,
    });

    // Product ทั้งสองยัง confirmed_quantity = null ค่า default จาก fixture (ไม่เคยผ่าน submit จริง)
    const products = state.ticketProducts.filter((product) => product.ticket_id === ticket.id);

    assert.ok(products.every((product) => product.confirmed_quantity === null));

    await assertFinalizeRejects(market.id, 409, "CONFIRMED_QUANTITY_MISSING");

    assert.equal(market.financialized_at, null);
    assert.equal(ticket.final_stall_amount ?? null, null);
    assert.equal(state.ticketProductFinancials.length, 0);
  });

  test("finalizeMarketJobFinancials rejects with 409 TICKET_RATE_SNAPSHOT_INCOMPLETE when a completed booth's product is missing a rate snapshot field", async () => {
    const worker = addWorker(99112);
    const job = addDispatchableJob(99113, 1);
    const ticket = addTicketForTicketJob(job.id, 199114);
    const market = state.marketJobs.find((item) => item.id === ticket.market_job_id)!;

    ticket.status = "COMPLETED";
    ticket.confirmation_status = "COMPLETED";
    ticket.completed_at = new Date().toISOString();

    state.ticketWorkers.push({
      id: state.nextTicketWorkerId++,
      market_job_id: market.id,
      worker_id: worker.id,
      status: "WORKING",
      final_earning_amount: null,
      joined_at: new Date().toISOString(),
      cancelled_at: null,
      completed_at: null,
    });

    const products = state.ticketProducts.filter((product) => product.ticket_id === ticket.id);

    products.forEach((product, index) => {
      product.confirmed_quantity = index === 0 ? "10" : "4";
    });
    // Product แรกมี confirmed_quantity แล้ว แต่ rate snapshot ไม่ครบ (stall_rate_snapshot หาย) —
    // เกิดได้จริงกับข้อมูลเก่าก่อน Gate บันทึก Rate Snapshot ครบทุก field
    products[0].stall_rate_snapshot = null;

    await assertFinalizeRejects(market.id, 409, "TICKET_RATE_SNAPSHOT_INCOMPLETE");

    assert.equal(market.financialized_at, null);
    assert.equal(ticket.final_stall_amount ?? null, null);
    assert.equal(state.ticketProductFinancials.length, 0);
  });

  // หมายเหตุ: hasCompleteRateSnapshot() (บรรทัด ~266 ของ ticket-financial.service.ts) เช็ค
  // stallRateSnapshot/laborRateSnapshot !== null รวมอยู่แล้วในเงื่อนไขเดียวกับ test ด้านบน ส่วน guard
  // ที่ซ้ำอีกชั้น (`if (stallRate === null || laborRate === null)`, บรรทัด ~279) ตามคอมเมนต์ในซอร์สเองระบุ
  // ว่ามีไว้เพื่อ TypeScript narrowing เท่านั้น (หลังผ่าน hasCompleteRateSnapshot แล้ว ค่าสองตัวนี้การันตีว่า
  // ไม่ null อยู่แล้วเสมอ) จึงเป็น dead code ที่ throw ไม่ได้จริงในทางปฏิบัติ ไม่มี test แยกสำหรับจุดนี้
});

/* -------------------------------------- Ticket-Level Worker Cancel Route Tests -------------------------------------- */

/* -------------------------------------- Admin Override Count Route Tests -------------------------------------- */

describe("Override Count", () => {
  test("POST /api/admin/vehicle-jobs/:ticketNumber/tickets/:ticketNo/stalls/:stallCode/override-count overrides product quantities and records the admin action", async () => {
    const { token } = await loginJobAdmin(9800);
    const job = addDispatchableJob(980, 1);
    const worker = addWorker(98001);
    const ticket = addTicketForTicketJob(job.id, 19800);
    const marketJob = state.marketJobs.find((item) => item.id === ticket.market_job_id);
    const products = state.ticketProducts.filter(
      (product) => product.ticket_id === ticket.id,
    );
    const assignment = addPendingAssignment(198001, job.id, worker.id);
    assignment.status = "SCANNED";
    assignment.scanned_at = new Date().toISOString();

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/tickets/${marketJob?.ticket_no}/stalls/${ticket.boothCode}/override-count`,
      {
        token,
        body: {
          reason_code: "R001",
          reason_text: "กรอกข้อมูลผิดพลาด",
          counts: products.map((product, index) => ({
            productCode: product.productCode,
            packageCode: product.packageCode,
            actual_quantity: index === 0 ? 15 : 4,
          })),
        },
      },
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.ticket_number, job.ticket_number);
    assert.equal(response.body.boothCode, ticket.boothCode);
    assert.equal(response.body.status, "DELIVERED");
    assert.equal(response.body.reason_code, "R001");
    assert.equal(response.body.products.length, 2);
    assert.equal(response.body.products[0].confirmed_quantity, "15");
    assert.equal(response.body.products[0].previous_quantity, null);

    const updatedProduct = state.ticketProducts.find(
      (product) => product.id === products[0].id,
    );

    assert.equal(updatedProduct?.confirmed_quantity, "15");

    const logs = state.adminActionLogs.filter(
      (item) => item.vehicle_job_id === job.id,
    );

    assert.equal(logs.length, 1);

    const [log] = logs;

    assert.equal(log.action_type, "OVERRIDE_COUNT");
    assert.equal(log.gate_ticket_id, ticket.id);
    assert.equal(log.reason_code, "R001");
    assert.equal(log.reason_text, "กรอกข้อมูลผิดพลาด");

    const submission = state.completionSubmissions.find(
      (item) => item.ticket_id === ticket.id,
    );

    assert.ok(submission);
    assert.equal(submission.submitted_by_role, "admin");
  });

  test("POST /api/admin/vehicle-jobs/:ticketNumber/tickets/:ticketNo/stalls/:stallCode/override-count rejects a request missing reason_code", async () => {
    const { token } = await loginJobAdmin(9805);
    const job = addDispatchableJob(9805, 1);
    const ticket = addTicketForTicketJob(job.id, 198050);
    const marketJob = state.marketJobs.find((item) => item.id === ticket.market_job_id);
    const products = state.ticketProducts.filter(
      (product) => product.ticket_id === ticket.id,
    );

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/tickets/${marketJob?.ticket_no}/stalls/${ticket.boothCode}/override-count`,
      {
        token,
        body: {
          counts: [
            {
              productCode: products[0].productCode,
              packageCode: products[0].packageCode,
              actual_quantity: 15,
            },
          ],
        },
      },
    );

    assert.equal(response.status, 400);

    const updatedProduct = state.ticketProducts.find(
      (product) => product.id === products[0].id,
    );

    assert.notEqual(updatedProduct?.confirmed_quantity, "15");

    const logs = state.adminActionLogs.filter(
      (item) => item.vehicle_job_id === job.id,
    );

    assert.equal(logs.length, 0);
  });

  test("POST /api/admin/vehicle-jobs/:ticketNumber/tickets/:ticketNo/stalls/:stallCode/override-count accepts reason_text explicitly sent as null (regression: reason_text used to be required, rejecting both null and omitted)", async () => {
    const { token } = await loginJobAdmin(98051);
    const job = addDispatchableJob(98052, 1);
    const worker = addWorker(980521);
    const ticket = addTicketForTicketJob(job.id, 198053);
    const marketJob = state.marketJobs.find((item) => item.id === ticket.market_job_id);
    const products = state.ticketProducts.filter(
      (product) => product.ticket_id === ticket.id,
    );
    const assignment = addPendingAssignment(1980531, job.id, worker.id);
    assignment.status = "SCANNED";
    assignment.scanned_at = new Date().toISOString();

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/tickets/${marketJob?.ticket_no}/stalls/${ticket.boothCode}/override-count`,
      {
        token,
        body: {
          reason_code: "R001",
          reason_text: null,
          counts: products.map((product, index) => ({
            productCode: product.productCode,
            packageCode: product.packageCode,
            actual_quantity: index === 0 ? 15 : 4,
          })),
        },
      },
    );

    assert.equal(response.status, 200, JSON.stringify(response.body));

    const [log] = state.adminActionLogs.filter(
      (item) => item.vehicle_job_id === job.id,
    );

    assert.equal(log.reason_code, "R001");
    assert.equal(log.reason_text, null);
  });

  test("POST /api/admin/vehicle-jobs/:ticketNumber/tickets/:ticketNo/stalls/:stallCode/override-count returns 404 for an unknown booth", async () => {
    const { token } = await loginJobAdmin(9810);
    const job = addDispatchableJob(981, 1);
    const ticket = addTicketForTicketJob(job.id, 19810);
    const marketJob = state.marketJobs.find((item) => item.id === ticket.market_job_id);

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/tickets/${marketJob?.ticket_no}/stalls/UNKNOWN-STALL/override-count`,
      {
        token,
        body: {
          reason_code: "R001",
          reason_text: "กรอกข้อมูลผิดพลาด",
          counts: [{ productCode: "X", packageCode: "Y", actual_quantity: 1 }],
        },
      },
    );

    assert.equal(response.status, 404);
    assert.equal(response.body.code, "TICKET_NOT_FOUND");
  });

  test("POST /api/admin/vehicle-jobs/:ticketNumber/tickets/:ticketNo/stalls/:stallCode/override-count returns 400 for a product not on the booth", async () => {
    const { token } = await loginJobAdmin(9820);
    const job = addDispatchableJob(982, 1);
    const worker = addWorker(98201);
    const ticket = addTicketForTicketJob(job.id, 19820);
    const marketJob = state.marketJobs.find((item) => item.id === ticket.market_job_id);
    const assignment = addPendingAssignment(198201, job.id, worker.id);
    assignment.status = "SCANNED";
    assignment.scanned_at = new Date().toISOString();

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/tickets/${marketJob?.ticket_no}/stalls/${ticket.boothCode}/override-count`,
      {
        token,
        body: {
          reason_code: "R001",
          reason_text: "กรอกข้อมูลผิดพลาด",
          counts: [
            { productCode: "UNKNOWN", packageCode: "UNKNOWN", actual_quantity: 1 },
          ],
        },
      },
    );

    assert.equal(response.status, 400);
    assert.equal(response.body.code, "INVALID_TICKET_PRODUCT");
  });

  test("POST /api/admin/vehicle-jobs/:ticketNumber/tickets/:ticketNo/stalls/:stallCode/override-count rejects a booth that already completed", async () => {
    const { token } = await loginJobAdmin(9830);
    const job = addDispatchableJob(983, 1);
    const ticket = addTicketForTicketJob(job.id, 19830);
    const marketJob = state.marketJobs.find((item) => item.id === ticket.market_job_id);
    const products = state.ticketProducts.filter(
      (product) => product.ticket_id === ticket.id,
    );

    ticket.status = "COMPLETED";

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/tickets/${marketJob?.ticket_no}/stalls/${ticket.boothCode}/override-count`,
      {
        token,
        body: {
          reason_code: "R001",
          reason_text: "กรอกข้อมูลผิดพลาด",
          counts: [
            {
              productCode: products[0].productCode,
              packageCode: products[0].packageCode,
              actual_quantity: 5,
            },
          ],
        },
      },
    );

    assert.equal(response.status, 409);
    assert.equal(response.body.code, "TICKET_ALREADY_CLOSED");
  });

  // financialized_at ในระบบจริงถูกตั้งพร้อมกับ status = COMPLETED เสมอ (finalizeMarketJobFinancials
  // เขียนทั้งคู่พร้อมกัน ไม่มีทางที่ Booth จะ financialized ทั้งที่ยัง WORKING/WAIT) — Test นี้จำลอง
  // สถานะที่สอดคล้องความเป็นจริง แล้วยืนยันว่า financialized ticket ที่ COMPLETED แล้วก็ยัง reject ถูก
  test("POST /api/admin/vehicle-jobs/:ticketNumber/tickets/:ticketNo/stalls/:stallCode/override-count rejects a booth that is already financialized", async () => {
    const { token } = await loginJobAdmin(9840);
    const job = addDispatchableJob(984, 1);
    const ticket = addTicketForTicketJob(job.id, 19840);
    const marketJob = state.marketJobs.find((item) => item.id === ticket.market_job_id);
    const products = state.ticketProducts.filter(
      (product) => product.ticket_id === ticket.id,
    );

    ticket.status = "COMPLETED";
    ticket.financialized_at = new Date().toISOString();

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/tickets/${marketJob?.ticket_no}/stalls/${ticket.boothCode}/override-count`,
      {
        token,
        body: {
          reason_code: "R001",
          reason_text: "กรอกข้อมูลผิดพลาด",
          counts: [
            {
              productCode: products[0].productCode,
              packageCode: products[0].packageCode,
              actual_quantity: 5,
            },
          ],
        },
      },
    );

    assert.equal(response.status, 409);
    assert.equal(response.body.code, "TICKET_ALREADY_CLOSED");
  });
});

// Full loop: Admin ส่งยอดแทน -> ทีม Worker ทั้งหมดได้รับแจ้งเตือน -> Vendor reject ผ่าน LINE ->
// Worker ส่งเองใหม่ได้ -> Vendor reject อีกครั้ง -> Admin ส่งแทนใหม่ได้อีก โดยทุกครั้งต้องบันทึกไว้ว่า
// Account ไหน Role อะไร เป็นผู้ส่งยอดล่าสุด (TicketCompletionSubmission.submitted_by_account_id /
// submitted_by_role) — ไม่ derive จาก Account.role เดี๋ยวนั้น
/* -------------------------------------- Admin Vehicle Wait Route Tests -------------------------------------- */

describe("Vehicle Job Wait", () => {
  test("POST /api/admin/vehicle-jobs/:ticketNumber/wait Dispatch:false before the team finishes scanning cancels the team's assignments and requeues them to the front of the queue", async () => {
    const { token } = await loginJobAdmin(9780);
    const job = addDispatchableJob(978, 2);
    const ticket = addTicketForTicketJob(job.id, 19780);
    // Booth ยังไม่เริ่มทำงานจริง (Fixture ปกติสร้าง Booth เป็น WORKING) จึงต้องปรับกลับเป็น WAIT เพื่อ
    // จำลองสถานการณ์จริง — ทีมยังไม่ Scan ครบ จึงไม่มีทางที่ Booth ไหนถูกส่งยอดหรือเริ่มทำงานได้เลย
    ticket.status = "WAIT";
    const worker1 = addWorker(97801);
    const worker2 = addWorker(97802);
    const bystander = addWorker(97803);

    // ทีมยังไม่ Scan ครบ (ต้องการ 2 คน scan ไปแล้วแค่ 1) — ยังอยู่ในช่วงที่อนุญาตให้ Dispatch:false ได้
    const assignment1 = addPendingAssignment(197801, job.id, worker1.id);
    assignment1.status = "ACCEPTED";
    const assignment2 = addPendingAssignment(197802, job.id, worker2.id);
    assignment2.status = "SCANNED";
    assignment2.scanned_at = new Date().toISOString();

    // Worker คนอื่นที่ต่อคิวไว้ก่อนแล้ว ใช้พิสูจน์ว่าทีมที่ถูกคืนเข้าคิวไปอยู่ "หน้าสุด" จริง ไม่ใช่ต่อท้าย
    await workerQueue.enqueueWorker(bystander.id);

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/wait`,
      {
        token,
        body: {
          dispatch: false,
          reason_code: "R003",
          reason_text: "รถยังไม่พร้อมเข้าจุดลงสินค้า",
        },
      },
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.status, "WAIT");
    assert.equal(response.body.dispatch_now, false);
    assert.equal(response.body.reason_code, "R003");
    assert.deepEqual(
      [...response.body.worker_to_queue].sort(),
      [worker1.labor_code, worker2.labor_code].sort(),
    );
    assert.equal(job.status, "WAIT");
    assert.equal(job.dispatch_now, false);
    assert.equal(assignment1.status, "CANCELLED");
    assert.equal(assignment2.status, "CANCELLED");
    // Booth ต้องไม่ถูกแตะ เพราะยังไม่มีใครเริ่มส่งยอดเลย (ยังเป็น WAIT อยู่แล้วตั้งแต่แรก)
    assert.equal(ticket.status, "WAIT");

    const ranks = await workerQueue.getWorkerReadyQueueRanks([
      worker1.id,
      worker2.id,
      bystander.id,
    ]);

    assert.ok((ranks.get(worker1.id) ?? Infinity) < (ranks.get(bystander.id) ?? -1));
    assert.ok((ranks.get(worker2.id) ?? Infinity) < (ranks.get(bystander.id) ?? -1));

    const log = state.adminActionLogs.find(
      (item) => item.vehicle_job_id === job.id,
    );

    assert.ok(log);
    assert.equal(log.action_type, "VEHICLE_WAIT");
    assert.equal(log.reason_text, "รถยังไม่พร้อมเข้าจุดลงสินค้า");
    assert.equal(log.metadata?.dispatch, false);
  });

  test("POST /api/admin/vehicle-jobs/:ticketNumber/wait Dispatch:true re-dispatches and pulls a worker from the queue for this vehicle job", async () => {
    const { token } = await loginJobAdmin(9790);
    const job = addDispatchableJob(979, 1);
    addTicketForTicketJob(job.id, 19790);
    // จำลองว่ารถถูกสั่ง Dispatch:false ไปก่อนหน้านี้แล้ว (รอลง ไม่มีทีมอยู่)
    job.dispatch_now = false;
    job.status = "WAIT";

    const queuedWorker = addWorker(97901);

    await workerQueue.enqueueWorker(queuedWorker.id);

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/wait`,
      {
        token,
        body: {
          dispatch: true,
          reason_code: "R004",
          reason_text: "รถพร้อมเข้าจุดลงสินค้าแล้ว",
        },
      },
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.status, "WORKING");
    assert.equal(response.body.dispatch_now, true);
    assert.deepEqual(response.body.worker_to_queue, []);
    assert.equal(job.status, "WORKING");
    assert.equal(job.dispatch_now, true);

    const newAssignment = state.assignments.find(
      (assignment) =>
        assignment.vehicle_job_id === job.id &&
        assignment.worker_id === queuedWorker.id,
    );

    assert.ok(newAssignment);
    assert.equal(newAssignment.status, "PENDING");

    const log = state.adminActionLogs.find(
      (item) => item.vehicle_job_id === job.id,
    );

    assert.ok(log);
    assert.equal(log.metadata?.dispatch, true);
  });

  test("POST /api/admin/vehicle-jobs/:ticketNumber/wait rejects toggling dispatch once the whole team has already checked in", async () => {
    const { token } = await loginJobAdmin(9860);
    const job = addDispatchableJob(986, 1);
    addTicketForTicketJob(job.id, 19860);
    const worker = addWorker(98601);
    const assignment = addPendingAssignment(198601, job.id, worker.id);

    assignment.status = "SCANNED";
    assignment.scanned_at = new Date().toISOString();

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/wait`,
      {
        token,
        body: {
          dispatch: false,
          reason_code: "R003",
          reason_text: "ทดสอบ",
        },
      },
    );

    assert.equal(response.status, 409);
    assert.equal(response.body.code, "VEHICLE_JOB_ALREADY_STARTED");
    assert.equal(job.status, "WORKING");
    assert.equal(assignment.status, "SCANNED");
  });

  test("POST /api/admin/vehicle-jobs/:ticketNumber/wait rejects a vehicle job that is already completed", async () => {
    const { token } = await loginJobAdmin(9870);
    const job = addDispatchableJob(987, 1);
    addTicketForTicketJob(job.id, 19870);
    job.status = "COMPLETED";

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/wait`,
      {
        token,
        body: {
          dispatch: false,
          reason_code: "R003",
          reason_text: "ทดสอบ",
        },
      },
    );

    assert.equal(response.status, 409);
    assert.equal(response.body.code, "VEHICLE_JOB_CLOSED");
  });

  test("POST /api/admin/vehicle-jobs/:ticketNumber/wait rejects a request missing the dispatch field", async () => {
    const { token } = await loginJobAdmin(9895);
    const job = addDispatchableJob(9895, 1);
    addTicketForTicketJob(job.id, 198950);

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/wait`,
      {
        token,
        body: {
          reason_code: "R003",
          reason_text: "ทดสอบ",
        },
      },
    );

    assert.equal(response.status, 400);
  });

  test("POST /api/admin/vehicle-jobs/:ticketNumber/wait accepts reason_text omitted entirely (regression: reason_text used to be required, rejecting both null and omitted)", async () => {
    const { token } = await loginJobAdmin(98961);
    const job = addDispatchableJob(98962, 1);
    addTicketForTicketJob(job.id, 198963);

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/wait`,
      {
        token,
        body: {
          dispatch: false,
          reason_code: "R003",
        },
      },
    );

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.reason_code, "R003");

    const log = state.adminActionLogs.find((item) => item.vehicle_job_id === job.id);

    assert.ok(log);
    assert.equal(log.reason_code, "R003");
    assert.equal(log.reason_text, null);
  });
});

/* -------------------------------------- Admin Release Workers Route Tests -------------------------------------- */

describe("Release Workers", () => {
  test("POST /api/admin/vehicle-jobs/:ticketNumber/release-workers releases workers back to the FIFO queue right after submit, without waiting for vendor confirmation", async () => {
    const { token: adminToken } = await loginJobAdmin(9880);
    const { token: workerToken, worker } = await loginWorker(9881);
    const job = addDispatchableJob(988, 1);
    job.tickets_closed_at = null;
    const ticket = addTicketForTicketJob(job.id, 19880);
    const assignment = addPendingAssignment(19881, job.id, worker.id);
    assignment.status = "SCANNED";
    assignment.scanned_at = new Date().toISOString();
    state.connectedWorkers.add(worker.id);
    await workerQueue.markWorkerAssigned(worker.id);

    const products = state.ticketProducts.filter(
      (product) => product.ticket_id === ticket.id,
    );
    const market = state.marketJobs.find((item) => item.id === ticket.market_job_id)!;

    const submitResponse = await server.request(
      "POST",
      `/api/workers/me/assignments/tickets/complete`,
      {
        token: workerToken,
        body: {
          ticket_no: market.ticket_no,
          boothCode: ticket.boothCode,
          items: products.map((product, index) => ({
            productCode: product.productCode,
            packageCode: product.packageCode,
            confirmed_quantity: index === 0 ? 10 : 4,
          })),
        },
      },
    );

    assert.equal(submitResponse.status, 200);

    // Worker ส่งยอดครบแล้ว (DELIVERED) แต่ Vendor ยังไม่ได้กดยืนยันหรือ timeout เลย — งานทางกาย
    // ของ Worker จบแล้ว ไม่ต้องรอ Vendor ก่อนถึงจะ release ได้
    assert.equal(ticket.status, "DELIVERED");
    assert.equal(job.status, "WORKING");
    assert.equal(assignment.status, "DELIVERED");
    assert.equal((await workerQueue.getWorkerQueueStatus(worker.id))?.status, "assigned");

    // Booth ทุกใบส่งยอดครบแล้ว ไม่มีความต้องการ Worker เพิ่มสำหรับรถคันนี้อีก (จำลอง SUM ที่ควรจะ
    // ลดลงเหลือ 0 เมื่อไม่มี Booth เหลือให้ทำ) เพื่อไม่ให้ Dispatch จับ Worker ที่เพิ่ง Release กลับมาทันที
    job.workers_required = 0;

    const releaseResponse = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/release-workers`,
      {
        token: adminToken,
        body: {
          reason_code: "R004",
          reason_text: "แรงงานส่งยอดครบแล้ว",
        },
      },
    );

    assert.equal(releaseResponse.status, 200);
    assert.deepEqual(releaseResponse.body.released_worker_codes, [worker.labor_code]);
    assert.equal(assignment.status, "RELEASED");
    assert.ok(assignment.released_at);
    assert.equal((await workerQueue.getWorkerQueueStatus(worker.id))?.status, "ready");

    // ปล่อย Worker ไปแล้ว แต่ตัวงาน/Ticket ยังไม่ complete จนกว่า Vendor จะยืนยันหรือ timeout จริง —
    // TicketJob.status ขยับเป็น RELEASED (ไม่ใช่ WORKING เดิม) กัน dispatch ดึง worker กลับเข้ามาซ้ำ
    assert.equal(ticket.status, "DELIVERED");
    assert.equal(job.status, "RELEASED");

    const log = state.adminActionLogs.find(
      (item) => item.vehicle_job_id === job.id,
    );

    assert.ok(log);
    assert.equal(log.action_type, "WORKERS_RELEASED");
  });

  test("POST /api/admin/vehicle-jobs/:ticketNumber/release-workers rejects when a booth has an unresolved vendor rejection", async () => {
    const { token: adminToken } = await loginJobAdmin(9885);
    const { worker } = await loginWorker(9886);
    const job = addDispatchableJob(9885, 1);
    const ticket = addTicketForTicketJob(job.id, 198850);
    addPendingAssignment(198851, job.id, worker.id);
    ticket.status = "REJECT";

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/release-workers`,
      {
        token: adminToken,
        body: {
          reason_code: "R004",
        },
      },
    );

    assert.equal(response.status, 409);
    assert.equal(response.body.code, "BOOTHS_NOT_SUBMITTED");
  });

  test("POST /api/admin/vehicle-jobs/:ticketNumber/release-workers rejects when a booth is still pending submission", async () => {
    const { token: adminToken } = await loginJobAdmin(9890);
    const { worker } = await loginWorker(9891);
    const job = addDispatchableJob(989, 1);
    addTicketForTicketJob(job.id, 19890);
    addPendingAssignment(19891, job.id, worker.id);

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/release-workers`,
      {
        token: adminToken,
        body: {
          reason_code: "R004",
        },
      },
    );

    assert.equal(response.status, 409);
    assert.equal(response.body.code, "BOOTHS_NOT_SUBMITTED");
  });

  test("POST /api/admin/vehicle-jobs/:ticketNumber/release-workers rejects a vehicle job that is already completed", async () => {
    const { token: adminToken } = await loginJobAdmin(9900);
    const job = addDispatchableJob(990, 1);
    addTicketForTicketJob(job.id, 19900);
    job.status = "COMPLETED";

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/release-workers`,
      {
        token: adminToken,
        body: {
          reason_code: "R004",
        },
      },
    );

    assert.equal(response.status, 409);
    assert.equal(response.body.code, "VEHICLE_JOB_CLOSED");
  });

  test("POST /api/admin/vehicle-jobs/:ticketNumber/release-workers moves status to RELEASED so a global dispatch pass never immediately reassigns a worker back onto the same job (even when workers_required is left unchanged and another worker is ready in the queue)", async () => {
    const { token: adminToken } = await loginJobAdmin(9905);
    const { token: workerToken, worker } = await loginWorker(9906);
    const bait = addWorker(99070);

    // ตั้งใจไม่ zero job.workers_required (ต่างจากเทสต์อื่นในไฟล์นี้) เพื่อจำลองสภาพ production จริง
    // พิสูจน์ว่า status=RELEASED เพียงพอที่จะกัน dispatch ซ้ำได้จริง โดยไม่ต้องพึ่ง workaround นี้
    const job = addDispatchableJob(9907, 1);
    job.tickets_closed_at = null;
    const ticket = addTicketForTicketJob(job.id, 199070);
    const assignment = addPendingAssignment(199071, job.id, worker.id);
    assignment.status = "SCANNED";
    assignment.scanned_at = new Date().toISOString();
    state.connectedWorkers.add(worker.id);
    await workerQueue.markWorkerAssigned(worker.id);
    // มี Worker อีกคนนั่งรออยู่ในคิว FIFO สถานะ "ready" อยู่ก่อนแล้ว ก่อนที่ release-workers จะทำงาน
    await workerQueue.enqueueWorker(bait.id);

    const products = state.ticketProducts.filter((p) => p.ticket_id === ticket.id);
    const market = state.marketJobs.find((item) => item.id === ticket.market_job_id)!;

    const submitResponse = await server.request(
      "POST",
      `/api/workers/me/assignments/tickets/complete`,
      {
        token: workerToken,
        body: {
          ticket_no: market.ticket_no,
          boothCode: ticket.boothCode,
          items: products.map((product, index) => ({
            productCode: product.productCode,
            packageCode: product.packageCode,
            confirmed_quantity: index === 0 ? 10 : 4,
          })),
        },
      },
    );

    assert.equal(submitResponse.status, 200);

    // ไม่ set job.workers_required = 0 ตรงนี้ ตรงกับสภาพ production จริง — ต้องยังปลอดภัยอยู่ดี
    const releaseResponse = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/release-workers`,
      {
        token: adminToken,
        body: { reason_code: "R004", reason_text: "แรงงานส่งยอดครบแล้ว" },
      },
    );

    assert.equal(releaseResponse.status, 200, JSON.stringify(releaseResponse.body));

    const assignmentsOnJob = state.assignments.filter(
      (item) => item.vehicle_job_id === job.id,
    );

    // มี assignment เดียวคือตัวเดิมที่ RELEASED แล้ว ไม่มี assignment ใหม่ถูกสร้างเพิ่มขึ้นมาเลย
    assert.equal(assignmentsOnJob.length, 1);
    assert.equal(assignmentsOnJob[0].status, "RELEASED");
    assert.equal((await workerQueue.getWorkerQueueStatus(worker.id))?.status, "ready");
    // Worker อีกคนที่รออยู่ในคิวก่อนหน้าก็ไม่ถูกดึงเข้ามาในงานที่เพิ่ง release เช่นกัน
    assert.equal((await workerQueue.getWorkerQueueStatus(bait.id))?.status, "ready");
    // dispatch_now ไม่ถูกแตะเลย ยังเป็นค่าเดิม (true) — ตัวที่เปลี่ยนคือ status เท่านั้น
    assert.equal(job.dispatch_now, true);
    assert.equal(job.status, "RELEASED");
  });

  // Function หา postback token จากปุ่มบน LINE flex message ล่าสุดที่พูดถึง boothCode ที่ระบุ
  function findLinePostbackByBoothCode(boothCode: string, label: "ถูกต้อง" | "ไม่ถูกต้อง"): string {
    const messages = [...state.lineMessages].reverse();

    for (const message of messages as Array<{
      data?: { messages?: Array<{ contents?: unknown }> };
    }>) {
      const contents = message?.data?.messages?.[0]?.contents as
        | { body?: unknown; footer?: { contents?: Array<{ action?: { label?: string; data?: string } }> } }
        | undefined;
      const bodyText = JSON.stringify(contents?.body ?? contents ?? "");

      if (!bodyText.includes(boothCode)) {
        continue;
      }

      const button = contents?.footer?.contents?.find(
        (candidate) => candidate.action?.label === label,
      );

      if (button?.action?.data) {
        return button.action.data;
      }
    }

    throw new Error(`No ${label} postback found for booth ${boothCode}`);
  }

  test("release-workers followed by confirming both booths of a multi-booth Business Ticket financializes correctly for the released worker (regression: roster used to be wrongly CANCELLED)", async () => {
    const { token: adminToken } = await loginJobAdmin(9911);
    const { token: workerToken, worker } = await loginWorker(9912);

    const job = addDispatchableJob(9913, 1);
    const market = addMarketJobForVehicle(job.id, {
      id: 39130,
      ticket_no: "TICKET-9913-39130",
      marketCode: "MARKET-9913-A",
    });
    const ticket1 = addTicketForTicketJob(job.id, 49131, market.id);
    const ticket2 = addTicketForTicketJob(job.id, 49132, market.id);
    const assignment = addPendingAssignment(59131, job.id, worker.id);
    assignment.status = "SCANNED";
    assignment.accepted_at = new Date().toISOString();
    assignment.scanned_at = new Date().toISOString();
    state.connectedWorkers.add(worker.id);
    await workerQueue.markWorkerAssigned(worker.id);

    async function submitBooth(ticket: typeof ticket1) {
      const products = state.ticketProducts.filter((p) => p.ticket_id === ticket.id);
      const response = await server.request(
        "POST",
        "/api/workers/me/assignments/tickets/complete",
        {
          token: workerToken,
          body: {
            ticket_no: market.ticket_no,
            boothCode: ticket.boothCode,
            items: products.map((product, index) => ({
              productCode: product.productCode,
              packageCode: product.packageCode,
              confirmed_quantity: index === 0 ? 10 : 4,
            })),
          },
        },
      );
      assert.equal(response.status, 200, JSON.stringify(response.body));
    }

    await submitBooth(ticket1);
    await submitBooth(ticket2);

    const releaseResponse = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/release-workers`,
      {
        token: adminToken,
        body: { reason_code: "R004", reason_text: "ส่งยอดครบทั้งสองแผงแล้ว" },
      },
    );
    assert.equal(releaseResponse.status, 200, JSON.stringify(releaseResponse.body));

    // Vendor ยืนยันแผง 1 ก่อน — market ยังไม่ terminal (แผง 2 ยังไม่ยืนยัน) จึงยัง sync roster ของ market
    // นี้อีกรอบ (activateNextTicketIfReady) — worker ที่ RELEASED แล้วต้องไม่ถูก sync ตัดออกจากทีม
    const confirmPostback1 = findLinePostbackByBoothCode(ticket1.boothCode, "ถูกต้อง");
    const confirmBody1 = {
      events: [
        {
          type: "postback",
          source: { userId: ticket1.vendor_line_id },
          postback: { data: confirmPostback1 },
        },
      ],
    };
    const confirm1 = await server.request("POST", "/api/line/webhook", {
      headers: { "x-line-signature": signLineWebhookBody(confirmBody1) },
      body: confirmBody1,
    });
    assert.equal(confirm1.status, 200);

    const ticketWorkerAfterFirstConfirm = state.ticketWorkers.find(
      (item) => item.market_job_id === market.id,
    );

    assert.ok(ticketWorkerAfterFirstConfirm);
    // Regression check: ต้องยัง WORKING อยู่ ไม่ถูก sync roster ตัดเป็น CANCELLED เพราะ assignment
    // เป็น RELEASED (ไม่ใช่ ACTIVE) — บั๊กเดิมทำให้ตรงนี้กลายเป็น CANCELLED และ final_earning_amount เป็น null
    assert.equal(ticketWorkerAfterFirstConfirm.status, "WORKING");

    const confirmPostback2 = findLinePostbackByBoothCode(ticket2.boothCode, "ถูกต้อง");
    const confirmBody2 = {
      events: [
        {
          type: "postback",
          source: { userId: ticket2.vendor_line_id },
          postback: { data: confirmPostback2 },
        },
      ],
    };
    const confirm2 = await server.request("POST", "/api/line/webhook", {
      headers: { "x-line-signature": signLineWebhookBody(confirmBody2) },
      body: confirmBody2,
    });
    assert.equal(confirm2.status, 200);

    assert.equal(job.status, "COMPLETED");

    const historyResponse = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history",
      { token: adminToken },
    );
    const item = historyResponse.body.data.find(
      (entry: { vehicle_job: { ticket_number: string } }) =>
        entry.vehicle_job.ticket_number === job.ticket_number,
    );

    assert.ok(item);
    // Regression check: การเงินต้องไม่ใช่ 0 — บั๊กเดิมทำให้ finalize มองว่าไม่มี WORKING worker เลย
    assert.notEqual(item.finance.workers[0].total_amount, "0.00");
    assert.equal(item.finance.workers[0].worker_code, worker.labor_code);
  });

  test("Worker or Admin can still resubmit a booth rejected by Vendor after release-workers, even though the worker no longer has an active assignment on this vehicle job (regression: used to 404 ASSIGNMENT_NOT_FOUND)", async () => {
    const { token: adminToken } = await loginJobAdmin(9914);
    const { token: workerToken, worker } = await loginWorker(9915);

    const job = addDispatchableJob(9916, 1);
    const market = addMarketJobForVehicle(job.id, {
      id: 39160,
      ticket_no: "TICKET-9916-39160",
      marketCode: "MARKET-9916-A",
    });
    const ticket1 = addTicketForTicketJob(job.id, 49161, market.id);
    const ticket2 = addTicketForTicketJob(job.id, 49162, market.id);
    const assignment = addPendingAssignment(59161, job.id, worker.id);
    assignment.status = "SCANNED";
    assignment.accepted_at = new Date().toISOString();
    assignment.scanned_at = new Date().toISOString();
    state.connectedWorkers.add(worker.id);
    await workerQueue.markWorkerAssigned(worker.id);

    async function submitBooth(ticket: typeof ticket1) {
      const products = state.ticketProducts.filter((p) => p.ticket_id === ticket.id);
      const response = await server.request(
        "POST",
        "/api/workers/me/assignments/tickets/complete",
        {
          token: workerToken,
          body: {
            ticket_no: market.ticket_no,
            boothCode: ticket.boothCode,
            items: products.map((product, index) => ({
              productCode: product.productCode,
              packageCode: product.packageCode,
              confirmed_quantity: index === 0 ? 10 : 4,
            })),
          },
        },
      );
      assert.equal(response.status, 200, JSON.stringify(response.body));
    }

    await submitBooth(ticket1);
    await submitBooth(ticket2);

    const releaseResponse = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/release-workers`,
      {
        token: adminToken,
        body: { reason_code: "R004", reason_text: "ส่งยอดครบทั้งสองแผงแล้ว" },
      },
    );
    assert.equal(releaseResponse.status, 200, JSON.stringify(releaseResponse.body));
    assert.equal(assignment.status, "RELEASED");

    const rejectPostback = findLinePostbackByBoothCode(ticket1.boothCode, "ไม่ถูกต้อง");
    const rejectBody = {
      events: [
        {
          type: "postback",
          source: { userId: ticket1.vendor_line_id },
          postback: { data: `${rejectPostback}&reject_reason=wrong_amount` },
        },
      ],
    };
    const rejectResponse = await server.request("POST", "/api/line/webhook", {
      headers: { "x-line-signature": signLineWebhookBody(rejectBody) },
      body: rejectBody,
    });
    assert.equal(rejectResponse.status, 200);
    assert.equal(ticket1.status, "REJECT");

    // Worker เองส่งยอดใหม่ให้แผง 1 — ต้องสำเร็จ แม้ assignment ของตัวเองจะเป็น RELEASED (ไม่ active) แล้ว
    const products1 = state.ticketProducts.filter((p) => p.ticket_id === ticket1.id);
    const resubmit = await server.request(
      "POST",
      "/api/workers/me/assignments/tickets/complete",
      {
        token: workerToken,
        body: {
          ticket_no: market.ticket_no,
          boothCode: ticket1.boothCode,
          items: products1.map((product, index) => ({
            productCode: product.productCode,
            packageCode: product.packageCode,
            confirmed_quantity: index === 0 ? 10 : 4,
          })),
        },
      },
    );

    assert.equal(resubmit.status, 200, JSON.stringify(resubmit.body));
    assert.equal(ticket1.status, "DELIVERED");
  });

  test("POST /api/admin/vehicle-jobs/:ticketNumber/release-workers returns 409 NO_SUBMITTED_BOOTHS when the vehicle job has no Business Ticket/booth at all yet", async () => {
    const { token: adminToken } = await loginJobAdmin(99080);
    // addDispatchableJob เพียงอย่างเดียวไม่สร้าง MarketJob/BoothJob ใดๆ เลย -> tickets ว่างเปล่า
    const job = addDispatchableJob(99081, 1);

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/release-workers`,
      {
        token: adminToken,
        body: { reason_code: "R004" },
      },
    );

    assert.equal(response.status, 409);
    assert.equal(response.body.code, "NO_SUBMITTED_BOOTHS");
    assert.equal(job.status, "WORKING");
    assert.equal(
      state.adminActionLogs.some((item) => item.vehicle_job_id === job.id),
      false,
    );
  });

  test("POST /api/admin/vehicle-jobs/:ticketNumber/release-workers returns 409 NO_RELEASABLE_WORKERS when every booth is resolved but no assignment is in a releasable status", async () => {
    const { token: adminToken } = await loginJobAdmin(99082);
    const job = addDispatchableJob(99083, 1);
    const ticket = addTicketForTicketJob(job.id, 199084);

    // Booth ถูกยกเลิกไปแล้ว (นับเป็น "resolved" ตาม SUBMITTED_TICKET_STATUSES) แต่ไม่มี Worker คนไหน
    // ถูก Assign เข้ามาเลย -> ไม่มี assignment ให้ release
    ticket.status = "CANCELLED";

    const response = await server.request(
      "POST",
      `/api/admin/vehicle-jobs/${job.ticket_number}/release-workers`,
      {
        token: adminToken,
        body: { reason_code: "R004" },
      },
    );

    assert.equal(response.status, 409);
    assert.equal(response.body.code, "NO_RELEASABLE_WORKERS");
    assert.equal(job.status, "WORKING");
    assert.equal(
      state.adminActionLogs.some((item) => item.vehicle_job_id === job.id),
      false,
    );
  });
});

/* -------------------------------------- Work History Route Tests -------------------------------------- */

describe("Vehicle Job History", () => {
  test("GET /api/admin/vehicle-jobs/history?dropoff_point filters to vehicles with at least one matching MarketJob.dropoffPoint, applied before pagination", async () => {
    const { token } = await loginJobAdmin(9945);

    const dockAJob = addDispatchableJob(9946, 1);
    const dockAMarket = addMarketJobForVehicle(dockAJob.id, {
      id: 39460,
      ticket_no: "TICKET-9946-39460",
      marketCode: "MARKET-9946-A",
      dropoff_point: "Dock A1",
    });
    addTicketForTicketJob(dockAJob.id, 49460, dockAMarket.id);

    const dockBJob = addDispatchableJob(9947, 1);
    const dockBMarket = addMarketJobForVehicle(dockBJob.id, {
      id: 39470,
      ticket_no: "TICKET-9947-39470",
      marketCode: "MARKET-9947-A",
      dropoff_point: "Dock B2",
    });
    addTicketForTicketJob(dockBJob.id, 49470, dockBMarket.id);

    const response = await server.request(
      "GET",
      `/api/admin/vehicle-jobs/history?dropoff_point=${encodeURIComponent("Dock B2")}&page=1`,
      { token },
    );

    assert.equal(response.status, 200, JSON.stringify(response.body));
    const ticketNumbers = response.body.data.map(
      (item: { vehicle_job: { ticket_number: string } }) =>
        item.vehicle_job.ticket_number,
    );

    assert.ok(ticketNumbers.includes(dockBJob.ticket_number));
    assert.ok(!ticketNumbers.includes(dockAJob.ticket_number));
    // pagination.total ต้องคำนวณหลังใช้ dropoff_point filter แล้ว
    assert.equal(response.body.pagination.total, 1);
    // available_dropoff_points ต้องเห็นทุกตัวเลือกที่มีจริง (ทั้ง A1 และ B2) แม้กำลังกรองเหลือแค่ B2 อยู่
    assert.deepEqual(
      [...response.body.available_dropoff_points].sort(),
      ["Dock A1", "Dock B2"],
    );
  });

  test("GET /api/admin/vehicle-jobs/history returns Workers, Timeline, Finance and job-level timestamps once a Business Ticket finalizes", async () => {
    const { token: adminToken } = await loginJobAdmin(9950);
    const { token: workerToken, worker } = await loginWorker(9951);
    const job = addDispatchableJob(995, 1);
    job.tickets_closed_at = new Date().toISOString();
    job.work_started_at = "2026-07-23T08:45:00.000Z";
    const ticket = addTicketForTicketJob(job.id, 19950);
    const assignment = addPendingAssignment(19951, job.id, worker.id);
    assignment.status = "SCANNED";
    assignment.accepted_at = new Date().toISOString();
    assignment.scanned_at = new Date().toISOString();
    state.workerAssignmentEvents.push({
      id: state.nextWorkerAssignmentEventId++,
      assignment_id: assignment.id,
      worker_id: assignment.worker_id,
      vehicle_job_id: assignment.vehicle_job_id,
      event_type: "ASSIGNED",
      occurred_at: new Date().toISOString(),
      metadata: null,
      created_at: new Date().toISOString(),
    });
    state.connectedWorkers.add(worker.id);
    await workerQueue.markWorkerAssigned(worker.id);

    const products = state.ticketProducts.filter(
      (product) => product.ticket_id === ticket.id,
    );
    const market = state.marketJobs.find((item) => item.id === ticket.market_job_id)!;

    const submitResponse = await server.request(
      "POST",
      `/api/workers/me/assignments/tickets/complete`,
      {
        token: workerToken,
        body: {
          ticket_no: market.ticket_no,
          boothCode: ticket.boothCode,
          items: products.map((product, index) => ({
            productCode: product.productCode,
            packageCode: product.packageCode,
            confirmed_quantity: index === 0 ? 10 : 4,
          })),
        },
      },
    );

    assert.equal(submitResponse.status, 200);

    workerDispatch.startAssignmentTimeoutProcessing();
    const queueName = process.env.BULLMQ_ASSIGNMENT_TIMEOUT_QUEUE as string;
    const processor = state.workerProcessors.get(queueName);
    const submission = state.completionSubmissions.at(-1);

    assert.ok(submission);

    await processor!({
      data: {
        ticketId: ticket.id,
        submissionId: submission.id,
        kind: "vendor_confirm",
      },
    });

    const historyResponse = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history",
      { token: adminToken },
    );

    assert.equal(historyResponse.status, 200);
    assert.equal(historyResponse.body.data.length, 1);

    const item = historyResponse.body.data[0];

    assert.equal(item.vehicle_job.ticket_number, job.ticket_number);
    assert.ok(item.vehicle_job.ticket_created_at);
    assert.equal(item.vehicle_job.work_started_at, job.work_started_at ?? null);
    assert.ok(item.vehicle_job.submitted_complete_at);
    // completed_at ต้องเป็น TicketJob.completedAt จริงที่ persist ไว้ตอน Vendor Confirm (auto-timeout)
    assert.ok(item.vehicle_job.completed_at);
    assert.ok(typeof item.vehicle_job.duration_seconds === "number");
    assert.equal("work_start" in item.vehicle_job, false);
    assert.equal("vendor_confirmed_complete_at" in item.vehicle_job, false);
    assert.equal("created_at" in item.vehicle_job, false);
    assert.equal("updated_at" in item.vehicle_job, false);
    // plate_no/plate_province แทน license_plate/license_plate_province เดิม
    assert.equal(item.vehicle_job.plate_no, job.license_plate);
    assert.equal(item.vehicle_job.plate_province, job.license_plate_province);
    assert.equal("license_plate" in item.vehicle_job, false);
    assert.equal("license_plate_province" in item.vehicle_job, false);

    // Workers
    assert.equal(item.workers.length, 1);
    assert.equal(item.workers[0].worker_id, worker.id);
    assert.equal(item.workers[0].assignment_id, assignment.id);
    assert.equal(item.workers[0].worker_code, worker.labor_code);
    assert.ok(item.workers[0].accepted_at);
    assert.ok(item.workers[0].scanned_at);
    // started_at: Scan แล้วจึงต้องใช้ TicketJob.workStartedAt เป็นหลัก (fallback scanned_at ถ้าไม่มี)
    // ไม่ใช่ accepted_at อีกต่อไป
    assert.equal(
      item.workers[0].started_at,
      item.vehicle_job.work_started_at ?? item.workers[0].scanned_at,
    );
    assert.ok(item.workers[0].submitted_at);
    assert.equal(item.workers[0].cancellation, null);

    // Timeline
    const timelineTypes = item.timeline.map((entry: { type: string }) => entry.type);

    assert.ok(timelineTypes.includes("GATE_ARRIVAL"));
    assert.ok(timelineTypes.includes("WORKER_ASSIGNED"));
    assert.ok(timelineTypes.includes("COUNT_SUBMITTED"));
    assert.ok(timelineTypes.includes("TICKET_CONFIRMED"));
    // Timeline ต้องเรียงตามเวลาจริง
    const occurredAts = item.timeline.map((entry: { occurred_at: string }) => entry.occurred_at);
    const sortedOccurredAts = [...occurredAts].sort();

    assert.deepEqual(occurredAts, sortedOccurredAts);

    // Booth-level Finance (Reuse จาก formatAdminFinancialBooth)
    assert.equal(item.markets.length, 1);
    assert.equal("created_at" in item.markets[0], false);
    assert.equal("updated_at" in item.markets[0], false);
    assert.equal(item.markets[0].booths.length, 1);

    const booth = item.markets[0].booths[0];

    assert.equal(booth.financialized, true);
    assert.equal("financialized_at" in booth, false);
    assert.ok(booth.final_stall_amount);
    assert.equal(booth.submitted_by_codes.length, 1);
    assert.equal(booth.submitted_by_codes[0], worker.labor_code);
    assert.equal(booth.submitted_by_role, "worker");
    assert.deepEqual(booth.submission_worker_snapshot, [
      {
        worker_code: worker.labor_code,
        full_name: worker.full_name,
      },
    ]);
    assert.ok(booth.submitted_at);
    assert.ok(booth.confirmedAt);
    // Booth นี้จบผ่าน BullMQ Timeout auto-confirm (ไม่มี LINE webhook เรียกเลยในเทสต์นี้)
    assert.equal(booth.confirmed_by_type, "timeout");
    assert.deepEqual(booth.rejection_history, []);
    assert.ok(booth.company_share_rate);
    // ticket_id/ticket_no/marketCode/marketName ซ้ำกับข้อมูลระดับ Markets[] อยู่แล้ว ไม่ต้องแสดงซ้ำที่ Booth
    assert.equal("ticket_id" in booth, false);
    assert.equal("ticket_no" in booth, false);
    assert.equal("marketCode" in booth, false);
    assert.equal("marketName" in booth, false);
    assert.equal("reject_reason" in booth, false);
    // ticket_product_id เป็น internal PK ไม่ต้องเปิดเผยใน Work History
    assert.equal("ticket_product_id" in booth.products[0], false);

    // Job-level Finance
    assert.equal(item.finance.worker_count, 1);
    assert.equal(item.finance.total_worker_share, booth.summary.worker_payout_total);
    assert.equal(item.finance.stall_fee_total, booth.final_stall_amount);
    assert.equal(item.finance.workers.length, 1);
    assert.equal(item.finance.workers[0].worker_code, worker.labor_code);
  });

  test("POST .../assignment/cancel records exactly one ASSIGNMENT_CANCELLED AdminActionLog, and History cancellation/Timeline reflect the admin actor (not the worker)", async () => {
    const { token: adminToken } = await loginJobAdmin(9994);
    const worker = addWorker(99941);
    const job = addDispatchableJob(9994, 1);
    const assignment = addPendingAssignment(199941, job.id, worker.id);
    assignment.status = "SCANNED";
    assignment.accepted_at = new Date().toISOString();
    assignment.scanned_at = new Date().toISOString();

    const cancelResponse = await server.request(
      "POST",
      "/api/admin/vehicle-jobs/assignment/cancel",
      {
        token: adminToken,
        body: {
          ticket_number: job.ticket_number,
          worker_code: worker.labor_code,
          reason_code: "ADMIN_CANCEL_WORKER_ASSIGNMENT",
          reason_text: "ยกเลิกงานทดสอบ",
        },
      },
    );

    assert.equal(cancelResponse.status, 200);
    assert.equal(assignment.status, "CANCELLED");

    const logs = state.adminActionLogs.filter(
      (log) => log.vehicle_job_id === job.id && log.action_type === "ASSIGNMENT_CANCELLED",
    );

    assert.equal(logs.length, 1);
    assert.equal(logs[0].reason_code, "ADMIN_CANCEL_WORKER_ASSIGNMENT");
    assert.equal(logs[0].reason_text, "ยกเลิกงานทดสอบ");

    const historyResponse = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history",
      { token: adminToken },
    );

    const item = historyResponse.body.data[0];
    const workerEntry = item.workers.find(
      (entry: { worker_code: string }) => entry.worker_code === worker.labor_code,
    );

    assert.ok(workerEntry.cancellation);
    assert.ok(workerEntry.cancellation.cancelled_at);
    assert.equal(workerEntry.cancellation.reason_code, "ADMIN_CANCEL_WORKER_ASSIGNMENT");
    assert.equal(workerEntry.cancellation.reason_text, "ยกเลิกงานทดสอบ");
    assert.equal(workerEntry.cancellation.cancelled_by_type, "admin");
    assert.notEqual(workerEntry.cancellation.cancelled_by_name, worker.full_name);

    const timelineCancelEntry = item.timeline.find(
      (entry: { type: string }) => entry.type === "ADMIN_ACTION",
    );

    assert.ok(timelineCancelEntry);
    assert.equal(timelineCancelEntry.actor_type, "admin");
    assert.notEqual(timelineCancelEntry.actor_name, worker.full_name);
  });

  test("GET /api/admin/vehicle-jobs/history job-level finance.workers shows distinct real per-worker totals, not an average", async () => {
    const { token: adminToken } = await loginJobAdmin(9997);
    const workerA = addWorker(99971);
    const workerB = addWorker(99972);
    const job = addDispatchableJob(9997, 1);

    // Finance.Workers[] ต้องใช้ชุด Worker เดียวกับ Workers[] (คนที่กดรับงานจริง) เป็นตัวขับ loop —
    // ต้องมี accepted assignment จริงให้ทั้งสองคน ไม่ใช่แค่แถว ticket_workers ลอยๆ
    const assignmentA = addPendingAssignment(699971, job.id, workerA.id);
    assignmentA.status = "COMPLETED";
    assignmentA.accepted_at = new Date().toISOString();
    const assignmentB = addPendingAssignment(699972, job.id, workerB.id);
    assignmentB.status = "COMPLETED";
    assignmentB.accepted_at = new Date().toISOString();

    const marketA = addMarketJobForVehicle(job.id, { id: 39971, ticket_no: "TICKET-9997-A" });
    const marketB = addMarketJobForVehicle(job.id, { id: 39972, ticket_no: "TICKET-9997-B" });

    state.ticketWorkers.push(
      {
        id: 599971,
        market_job_id: marketA.id,
        worker_id: workerA.id,
        status: "COMPLETED",
        final_earning_amount: "100.00",
        joined_at: new Date().toISOString(),
        cancelled_at: null,
        completed_at: new Date().toISOString(),
      },
      {
        id: 599972,
        market_job_id: marketB.id,
        worker_id: workerA.id,
        status: "COMPLETED",
        final_earning_amount: "120.00",
        joined_at: new Date().toISOString(),
        cancelled_at: null,
        completed_at: new Date().toISOString(),
      },
      {
        id: 599973,
        market_job_id: marketA.id,
        worker_id: workerB.id,
        status: "COMPLETED",
        final_earning_amount: "45.00",
        joined_at: new Date().toISOString(),
        cancelled_at: null,
        completed_at: new Date().toISOString(),
      },
    );

    const historyResponse = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history",
      { token: adminToken },
    );

    const item = historyResponse.body.data[0];
    const earningsByCode = new Map(
      item.finance.workers.map((entry: { worker_code: string; total_amount: string }) => [
        entry.worker_code,
        entry.total_amount,
      ]),
    );

    // Worker A ทำ 2 Business Ticket รวม 220 ไม่ใช่เฉลี่ย, Worker B ทำใบเดียว 45
    assert.equal(earningsByCode.get(workerA.labor_code), "220.00");
    assert.equal(earningsByCode.get(workerB.labor_code), "45.00");

    const workerAEntry = item.finance.workers.find(
      (entry: { worker_code: string }) => entry.worker_code === workerA.labor_code,
    );

    assert.equal(workerAEntry.worker_id, workerA.id);
  });

  test("GET /api/admin/vehicle-jobs/history finance.workers excludes a worker who timed out before Scan and never earned a finalized payment", async () => {
    const { token: adminToken } = await loginJobAdmin(88890);
    const job = addDispatchableJob(8889, 2);
    const paidWorker = addWorker(88891);
    const timedOutWorker = addWorker(88892);

    // Paid worker: accepted, scanned, และมี ticket_workers ที่ finalize แล้วจริง
    const paidAssignment = addPendingAssignment(688891, job.id, paidWorker.id);
    paidAssignment.status = "COMPLETED";
    paidAssignment.accepted_at = new Date().toISOString();
    paidAssignment.scanned_at = new Date().toISOString();

    const market = addMarketJobForVehicle(job.id, { id: 88893, ticket_no: "TICKET-8889-A" });

    state.ticketWorkers.push({
      id: 588891,
      market_job_id: market.id,
      worker_id: paidWorker.id,
      status: "COMPLETED",
      final_earning_amount: "150.00",
      joined_at: new Date().toISOString(),
      cancelled_at: null,
      completed_at: new Date().toISOString(),
    });

    // Timed-out worker: กด Accept แล้วแต่ timeout ก่อน Scan — ไม่เคยมีแถว ticket_workers เลย จึงไม่มี
    // payment จริง ต้องไม่โผล่ใน finance.workers[] แม้จะเคย Accept assignment ก็ตาม
    const timedOutAssignment = addPendingAssignment(688892, job.id, timedOutWorker.id);
    timedOutAssignment.status = "CANCELLED";
    timedOutAssignment.accepted_at = new Date().toISOString();

    const historyResponse = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history",
      { token: adminToken },
    );

    const item = historyResponse.body.data.find(
      (entry: { vehicle_job: { ticket_number: string } }) =>
        entry.vehicle_job.ticket_number === job.ticket_number,
    );

    assert.ok(item);
    const financeCodes = item.finance.workers.map(
      (entry: { worker_code: string }) => entry.worker_code,
    );

    assert.ok(financeCodes.includes(paidWorker.labor_code));
    assert.ok(!financeCodes.includes(timedOutWorker.labor_code));
  });

  // Function ยิง GET /history พร้อม query params สำหรับกลุ่มเทสต์ history_status — server.request ไม่มี
  // option query แยก ต้องประกอบ query string เข้ากับ path เอง
  function requestHistory(
    adminToken: string,
    params: Record<string, string>,
  ) {
    return server.request(
      "GET",
      `/api/admin/vehicle-jobs/history?${new URLSearchParams(params).toString()}`,
      { token: adminToken },
    );
  }

  test("GET /api/admin/vehicle-jobs/history history_status=REJECT_PENDING returns a non-terminal vehicle job with a pending REJECT booth, and excludes one with no REJECT booth", async () => {
    const { token: adminToken } = await loginJobAdmin(990100);
    const rejectedJob = addDispatchableJob(990100, 1);
    const rejectedTicket = addTicketForTicketJob(rejectedJob.id, 1990101);

    rejectedTicket.status = "REJECT";

    const cleanJob = addDispatchableJob(990101, 1);

    addTicketForTicketJob(cleanJob.id, 1990111);

    const rejectedResponse = await requestHistory(adminToken, {
      history_status: "REJECT_PENDING",
      search: rejectedJob.ticket_number,
    });

    assert.equal(rejectedResponse.status, 200);
    assert.equal(rejectedResponse.body.data.length, 1);
    assert.equal(rejectedResponse.body.data[0].vehicle_job.history_status, "REJECT_PENDING");

    const cleanResponse = await requestHistory(adminToken, {
      history_status: "REJECT_PENDING",
      search: cleanJob.ticket_number,
    });

    assert.equal(cleanResponse.status, 200);
    assert.equal(cleanResponse.body.data.length, 0);
  });

  test("GET /api/admin/vehicle-jobs/history history_status=CANCELLED wins over a pending REJECT booth (CANCELLED has priority over REJECT_PENDING)", async () => {
    const { token: adminToken } = await loginJobAdmin(990104);
    const job = addDispatchableJob(990104, 1);
    const ticket = addTicketForTicketJob(job.id, 1990141);

    // Booth ยังค้าง REJECT อยู่ แต่รถทั้งคันถูกยกเลิกไปแล้ว — ต้องจัดกลุ่มเป็น CANCELLED ไม่ใช่
    // REJECT_PENDING (ลำดับความสำคัญ CANCELLED > COMPLETED > REJECT_PENDING)
    ticket.status = "REJECT";
    job.status = "CANCELLED";

    const cancelledResponse = await requestHistory(adminToken, {
      history_status: "CANCELLED",
      search: job.ticket_number,
    });

    assert.equal(cancelledResponse.status, 200);
    assert.equal(cancelledResponse.body.data.length, 1);
    assert.equal(cancelledResponse.body.data[0].vehicle_job.history_status, "CANCELLED");

    const rejectPendingResponse = await requestHistory(adminToken, {
      history_status: "REJECT_PENDING",
      search: job.ticket_number,
    });

    assert.equal(rejectPendingResponse.status, 200);
    assert.equal(rejectPendingResponse.body.data.length, 0);
  });

  test("GET /api/admin/vehicle-jobs/history history_status and status combine as AND", async () => {
    const { token: adminToken } = await loginJobAdmin(990106);
    const job = addDispatchableJob(990106, 1);

    addTicketForTicketJob(job.id, 1990161);
    job.status = "COMPLETED";

    const matchingResponse = await requestHistory(adminToken, {
      history_status: "COMPLETED",
      status: "COMPLETED",
      search: job.ticket_number,
    });

    assert.equal(matchingResponse.status, 200);
    assert.equal(matchingResponse.body.data.length, 1);

    // history_status=COMPLETED ตรง แต่ status=CANCELLED ไม่ตรง — ต้องเป็น AND จึงไม่คืนอะไรเลย
    const mismatchedResponse = await requestHistory(adminToken, {
      history_status: "COMPLETED",
      status: "CANCELLED",
      search: job.ticket_number,
    });

    assert.equal(mismatchedResponse.status, 200);
    assert.equal(mismatchedResponse.body.data.length, 0);
  });

  test("GET /api/admin/vehicle-jobs/history pagination.total counts after history_status is applied, not before", async () => {
    const { token: adminToken } = await loginJobAdmin(990107);
    const job = addDispatchableJob(990107, 1);
    const ticket = addTicketForTicketJob(job.id, 1990171);

    ticket.status = "REJECT";

    const response = await requestHistory(adminToken, {
      history_status: "REJECT_PENDING",
      search: job.ticket_number,
      page: "1",
      limit: "1",
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.pagination.total, 1);
    assert.equal(response.body.pagination.total_pages, 1);
  });

  test("GET /api/admin/vehicle-jobs/history booths[].cancellation resolves from its own STALL_JOB_CANCELLED log when a single booth is cancelled directly, without affecting its market or vehicle job", async () => {
    const { token: adminToken } = await loginJobAdmin(990300);
    const job = addDispatchableJob(990300, 1);
    const market = addMarketJobForVehicle(job.id, {
      id: 390300,
      ticket_no: "TICKET-990300",
    });
    const cancelledBooth = addTicketForTicketJob(job.id, 1990300, market.id);
    const otherBooth = addTicketForTicketJob(job.id, 1990301, market.id);

    const cancelResponse = await server.request(
      "POST",
      "/api/admin/vehicle-jobs/assignment/cancel",
      {
        token: adminToken,
        body: {
          ticket_number: job.ticket_number,
          ticket_no: market.ticket_no,
          boothCode: cancelledBooth.boothCode,
          reason_code: "STALL_CANCEL_REASON",
          reason_text: "ยกเลิกแผงเดียว",
        },
      },
    );

    assert.equal(cancelResponse.status, 200, JSON.stringify(cancelResponse.body));
    assert.equal(cancelledBooth.status, "CANCELLED");
    assert.equal(otherBooth.status, "WORKING");

    const response = await requestHistory(adminToken, { search: job.ticket_number });
    const item = response.body.data[0];
    const cancelledBoothResponse = item.markets[0].booths.find(
      (booth: { boothCode: string }) => booth.boothCode === cancelledBooth.boothCode,
    );
    const otherBoothResponse = item.markets[0].booths.find(
      (booth: { boothCode: string }) => booth.boothCode === otherBooth.boothCode,
    );

    assert.ok(cancelledBoothResponse.cancellation);
    assert.equal(cancelledBoothResponse.cancellation.reason_code, "STALL_CANCEL_REASON");
    assert.equal(cancelledBoothResponse.cancellation.reason_text, "ยกเลิกแผงเดียว");
    assert.equal(otherBoothResponse.cancellation, null);
    // ยกเลิกแผงเดียวไม่กระทบตลาดหรือทั้งคัน
    assert.equal(item.markets[0].cancellation, null);
    assert.equal(item.vehicle_job.cancellation, null);
  });

  test("GET /api/admin/vehicle-jobs/history vehicle_job.history_flags detects FINANCE_CALCULATED/WORKERS_RELEASED/BOOTH_REJECTED/AUTO_CONFIRMED/SUBMISSION_ROSTER_INCOMPLETE/ADMIN_SUBMITTED_ON_BEHALF together, in HISTORY_FLAG_VALUES order", async () => {
    const { token: adminToken } = await loginJobAdmin(990401);
    const worker = addWorker(9904011);
    // workersRequired = 3 เพื่อให้ workerCountSnapshot = 2 ต่ำกว่าจริง (SUBMISSION_ROSTER_INCOMPLETE)
    const job = addDispatchableJob(990401, 3);
    const ticket = addTicketForTicketJob(job.id, 1990410);
    const assignment = addPendingAssignment(1990411, job.id, worker.id);

    assignment.status = "RELEASED";
    assignment.accepted_at = new Date().toISOString();
    assignment.released_at = new Date().toISOString();
    ticket.financialized_at = new Date().toISOString();

    state.completionSubmissions.push(
      {
        // Reject รอบแรก — งานนี้เคย Reject แม้จะแก้สำเร็จภายหลัง ต้องยังติด BOOTH_REJECTED
        id: 6990410,
        ticket_id: ticket.id,
        submitted_by_account_id: worker.id,
        status: "REJECT",
        confirmed_at: null,
        rejected_at: "2026-07-23T09:00:00.000Z",
        resolved_by_line_user_id: null,
        created_at: "2026-07-23T08:50:00.000Z",
      },
      {
        // รอบแก้ไข — Admin ส่งแทน (ADMIN_SUBMITTED_ON_BEHALF), auto-confirm ผ่าน timeout
        // (resolved_by_line_user_id เป็น null แต่ confirmed_at มีค่า = AUTO_CONFIRMED), roster ไม่ครบ
        // (workerCountSnapshot 2 < workersRequired 3 = SUBMISSION_ROSTER_INCOMPLETE)
        id: 6990411,
        ticket_id: ticket.id,
        submitted_by_account_id: worker.id,
        submitted_by_role: "admin",
        status: "COMPLETED",
        confirmed_at: "2026-07-23T09:30:00.000Z",
        rejected_at: null,
        resolved_by_line_user_id: null,
        worker_count_snapshot: 2,
        created_at: "2026-07-23T09:10:00.000Z",
      },
    );

    const response = await requestHistory(adminToken, { search: job.ticket_number });

    assert.deepEqual(response.body.data[0].vehicle_job.history_flags, [
      "FINANCE_CALCULATED",
      "WORKERS_RELEASED",
      "BOOTH_REJECTED",
      "AUTO_CONFIRMED",
      "SUBMISSION_ROSTER_INCOMPLETE",
      "ADMIN_SUBMITTED_ON_BEHALF",
    ]);
  });

  test("GET /api/admin/vehicle-jobs/history company_share_rate is 0.00 when labor_fee_raw is 0 (no divide-by-zero)", async () => {
    const { token: adminToken } = await loginJobAdmin(99002);
    const worker = addWorker(990021);
    const job = addDispatchableJob(99002, 1);
    const ticket = addTicketForTicketJob(job.id, 1990020);
    const products = state.ticketProducts.filter(
      (product) => product.ticket_id === ticket.id,
    );

    state.ticketWorkers.push({
      id: 5990020,
      market_job_id: ticket.market_job_id,
      worker_id: worker.id,
      status: "COMPLETED",
      final_earning_amount: "0.00",
      joined_at: new Date().toISOString(),
      cancelled_at: null,
      completed_at: new Date().toISOString(),
    });

    state.ticketProductFinancials.push({
      id: 7990020,
      ticket_product_id: products[0].id,
      confirmed_quantity: "0",
      stall_fee_raw: "0",
      stall_fee_rounded: "0.00",
      labor_fee_raw: "0",
      product_charge: "0.00",
      worker_count: 1,
      worker_payout_total: "0.00",
      fund_amount: "0",
      finalized_at: new Date().toISOString(),
    });

    const historyResponse = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history",
      { token: adminToken },
    );

    const item = historyResponse.body.data[0];
    const booth = item.markets[0].booths[0];

    assert.equal(booth.company_share_rate, "0.00");
  });

  test("GET /api/admin/vehicle-jobs/history Booth worker_count uses the latest Submission's worker_count_snapshot, not earlier ones", async () => {
    const { token: adminToken } = await loginJobAdmin(99101);
    const workerA = addWorker(991011);
    const job = addDispatchableJob(99101, 1);
    const ticket = addTicketForTicketJob(job.id, 1991010);

    state.completionSubmissions.push(
      {
        id: 6991010,
        ticket_id: ticket.id,
        submitted_by_account_id: workerA.id,
        status: "REJECT",
        confirmed_at: null,
        rejected_at: "2026-07-23T09:00:00.000Z",
        resolved_by_line_user_id: null,
        worker_count_snapshot: 3,
        created_at: "2026-07-23T08:50:00.000Z",
      },
      {
        id: 6991011,
        ticket_id: ticket.id,
        submitted_by_account_id: workerA.id,
        status: "REJECT",
        confirmed_at: null,
        rejected_at: "2026-07-23T09:30:00.000Z",
        resolved_by_line_user_id: null,
        worker_count_snapshot: 2,
        created_at: "2026-07-23T09:15:00.000Z",
      },
      {
        id: 6991012,
        ticket_id: ticket.id,
        submitted_by_account_id: workerA.id,
        status: "DELIVERED",
        confirmed_at: null,
        rejected_at: null,
        resolved_by_line_user_id: null,
        worker_count_snapshot: 4,
        created_at: "2026-07-23T09:45:00.000Z",
      },
    );

    const historyResponse = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history",
      { token: adminToken },
    );

    const item = historyResponse.body.data[0];

    assert.equal(item.markets[0].booths[0].worker_count, 4);
  });

  test("GET /api/admin/vehicle-jobs/history returns submitted_by_role and submission_worker_snapshot from the SubmissionWorkerSnapshot roster at Submit time", async () => {
    const { token: adminToken } = await loginJobAdmin(99111);
    const workerA = addWorker(991111);
    const workerB = addWorker(991112);
    const job = addDispatchableJob(99111, 2);
    const ticket = addTicketForTicketJob(job.id, 1991110);

    state.ticketWorkers.push(
      {
        id: 6991111,
        market_job_id: ticket.market_job_id,
        worker_id: workerA.id,
        status: "COMPLETED",
        final_earning_amount: null,
        joined_at: new Date().toISOString(),
        cancelled_at: null,
        completed_at: null,
      },
      {
        id: 6991112,
        market_job_id: ticket.market_job_id,
        worker_id: workerB.id,
        status: "COMPLETED",
        final_earning_amount: null,
        joined_at: new Date().toISOString(),
        cancelled_at: null,
        completed_at: null,
      },
    );
    state.completionSubmissions.push({
      id: 6991110,
      ticket_id: ticket.id,
      submitted_by_account_id: workerA.id,
      submitted_by_role: "worker",
      status: "COMPLETED",
      confirmed_at: "2026-07-23T09:30:00.000Z",
      rejected_at: null,
      resolved_by_line_user_id: null,
      worker_count_snapshot: 2,
      created_at: "2026-07-23T09:00:00.000Z",
    });
    // SubmissionWorkerSnapshot ต้องผูกกับ submission (6991110) ไม่ใช่ ticket — คนละอันกับ
    // BoothJobWorkerSnapshot ที่ snapshot ทีหลังตอน Confirm
    state.submissionWorkerSnapshots.push(
      {
        id: 8991111,
        submission_id: 6991110,
        ticket_worker_id: 6991111,
        created_at: "2026-07-23T09:00:00.000Z",
      },
      {
        id: 8991112,
        submission_id: 6991110,
        ticket_worker_id: 6991112,
        created_at: "2026-07-23T09:00:00.000Z",
      },
    );

    const historyResponse = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history",
      { token: adminToken },
    );

    const booth = historyResponse.body.data[0].markets[0].booths[0];

    assert.equal(booth.submitted_by_role, "worker");
    assert.deepEqual(booth.submission_worker_snapshot, [
      {
        worker_code: workerA.labor_code,
        full_name: workerA.full_name,
      },
      {
        worker_code: workerB.labor_code,
        full_name: workerB.full_name,
      },
    ]);
  });

  test("GET /api/admin/vehicle-jobs/history Booth worker_count ignores the current TicketWorker roster after it changed post-submission", async () => {
    const { token: adminToken } = await loginJobAdmin(99102);
    const workerA = addWorker(991021);
    const workerB = addWorker(991022);
    const workerC = addWorker(991023);
    const workerD = addWorker(991024);
    const job = addDispatchableJob(99102, 1);
    const ticket = addTicketForTicketJob(job.id, 1991020);

    state.completionSubmissions.push({
      id: 6991020,
      ticket_id: ticket.id,
      submitted_by_account_id: workerA.id,
      status: "DELIVERED",
      confirmed_at: null,
      rejected_at: null,
      resolved_by_line_user_id: null,
      worker_count_snapshot: 2,
      created_at: "2026-07-23T09:00:00.000Z",
    });

    // Roster ปัจจุบันเปลี่ยนไปเป็น 4 คนหลัง Submit แล้ว — History ต้องไม่ใช้ตัวเลขนี้
    state.ticketWorkers.push(
      {
        id: 6991021,
        market_job_id: ticket.market_job_id,
        worker_id: workerA.id,
        status: "WORKING",
        final_earning_amount: null,
        joined_at: new Date().toISOString(),
        cancelled_at: null,
        completed_at: null,
      },
      {
        id: 6991022,
        market_job_id: ticket.market_job_id,
        worker_id: workerB.id,
        status: "WORKING",
        final_earning_amount: null,
        joined_at: new Date().toISOString(),
        cancelled_at: null,
        completed_at: null,
      },
      {
        id: 6991023,
        market_job_id: ticket.market_job_id,
        worker_id: workerC.id,
        status: "WORKING",
        final_earning_amount: null,
        joined_at: new Date().toISOString(),
        cancelled_at: null,
        completed_at: null,
      },
      {
        id: 6991024,
        market_job_id: ticket.market_job_id,
        worker_id: workerD.id,
        status: "WORKING",
        final_earning_amount: null,
        joined_at: new Date().toISOString(),
        cancelled_at: null,
        completed_at: null,
      },
    );

    const historyResponse = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history",
      { token: adminToken },
    );

    const item = historyResponse.body.data[0];

    assert.equal(item.markets[0].booths[0].worker_count, 2);
  });
});

/* -------------------------------------- Daily Worker Income Route Tests -------------------------------------- */

describe("Daily Worker Income", () => {
  test("GET /api/admin/vehicle-jobs/history/daily-worker-income lists one row per Worker per Business Ticket with the locked payout", async () => {
    const { token: adminToken } = await loginJobAdmin(9970);
    const { token: workerToken, worker } = await loginWorker(9971);
    worker.coat_no = "7";
    const job = addDispatchableJob(997, 1);
    job.tickets_closed_at = new Date().toISOString();
    const ticket = addTicketForTicketJob(job.id, 19970);
    const assignment = addPendingAssignment(19971, job.id, worker.id);
    assignment.status = "SCANNED";
    assignment.accepted_at = new Date().toISOString();
    assignment.scanned_at = new Date().toISOString();
    state.connectedWorkers.add(worker.id);
    await workerQueue.markWorkerAssigned(worker.id);

    const products = state.ticketProducts.filter(
      (product) => product.ticket_id === ticket.id,
    );
    const market = state.marketJobs.find((item) => item.id === ticket.market_job_id)!;

    const submitResponse = await server.request(
      "POST",
      `/api/workers/me/assignments/tickets/complete`,
      {
        token: workerToken,
        body: {
          ticket_no: market.ticket_no,
          boothCode: ticket.boothCode,
          items: products.map((product, index) => ({
            productCode: product.productCode,
            packageCode: product.packageCode,
            confirmed_quantity: index === 0 ? 10 : 4,
          })),
        },
      },
    );

    assert.equal(submitResponse.status, 200);

    workerDispatch.startAssignmentTimeoutProcessing();
    const queueName = process.env.BULLMQ_ASSIGNMENT_TIMEOUT_QUEUE as string;
    const processor = state.workerProcessors.get(queueName);
    const submission = state.completionSubmissions.at(-1);

    assert.ok(submission);

    await processor!({
      data: {
        ticketId: ticket.id,
        submissionId: submission.id,
        kind: "vendor_confirm",
      },
    });

    const marketJob = state.marketJobs.find(
      (item) => item.id === ticket.market_job_id,
    );
    const ticketWorker = state.ticketWorkers.find(
      (item) => item.market_job_id === ticket.market_job_id,
    );

    assert.ok(marketJob);
    assert.ok(ticketWorker);
    assert.ok(ticketWorker.final_earning_amount);

    const response = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/daily-worker-income",
      { token: adminToken },
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 1);

    const row = response.body.data[0];

    assert.equal(row.id, undefined);
    assert.equal(row.ticket_no, marketJob.ticket_no);
    assert.equal(row.plate, job.license_plate);
    assert.equal(row.worker.code, worker.labor_code);
    // shirt_number ต้องมาจาก coat_no (เบอร์เสื้อ) ไม่ใช่ labor_color (สีเสื้อ) เหมือน field shirt เดิม
    assert.equal(row.worker.shirt_number, worker.coat_no);
    assert.equal("shirt" in row.worker, false);
    assert.equal(row.payable, ticketWorker.final_earning_amount);
    assert.equal(row.payment_status, "success");
    assert.ok(row.accepted_at);
    assert.ok(row.scanned_at);
    assert.ok(row.submitted_at);
    assert.ok(row.confirmedAt);
    assert.equal(row.cancellation, null);
    assert.equal(row.riskText, "-");
  });

  test("GET /api/admin/vehicle-jobs/history/daily-worker-income payment_status = partially_paid when the worker was individually cancelled from a ticket_no that still completed, but already earned something", async () => {
    const { token: adminToken } = await loginJobAdmin(99701);
    const worker = addWorker(99711);
    const job = addDispatchableJob(9971, 1);
    const ticket = addTicketForTicketJob(job.id, 199710);
    const market = state.marketJobs.find((item) => item.id === ticket.market_job_id)!;
    market.status = "COMPLETED";

    state.ticketWorkers.push({
      id: state.nextTicketWorkerId++,
      market_job_id: ticket.market_job_id,
      worker_id: worker.id,
      status: "CANCELLED",
      final_earning_amount: "5.00",
      joined_at: new Date().toISOString(),
      cancelled_at: new Date().toISOString(),
      completed_at: null,
    });

    const response = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/daily-worker-income",
      { token: adminToken },
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 1);
    assert.equal(response.body.data[0].payment_status, "partially_paid");
    assert.equal(response.body.data[0].payable, "5.00");
    assert.equal(response.body.data[0].riskText, "Admin เตะคนงานกลางคัน, จ่ายเฉพาะแผงที่ยืนยันแล้ว");
  });

  test("GET /api/admin/vehicle-jobs/history/daily-worker-income excludes a row entirely when it does not match any of the 5 payment statuses (still WORKING, no reject, not cancelled)", async () => {
    const { token: adminToken } = await loginJobAdmin(99702);
    const worker = addWorker(99712);
    const job = addDispatchableJob(9972, 1);
    const ticket = addTicketForTicketJob(job.id, 199720);

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

    const response = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/daily-worker-income",
      { token: adminToken },
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 0);
  });

  test("GET /api/admin/vehicle-jobs/history/daily-worker-income payment_status = worker_reject when a booth is REJECT and the worker was never released", async () => {
    const { token: adminToken } = await loginJobAdmin(99703);
    const worker = addWorker(99713);
    const job = addDispatchableJob(9973, 1);
    const ticket = addTicketForTicketJob(job.id, 199730);
    ticket.status = "REJECT";
    const assignment = addPendingAssignment(199731, job.id, worker.id);
    assignment.status = "SCANNED";
    assignment.scanned_at = new Date().toISOString();

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

    const response = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/daily-worker-income",
      { token: adminToken },
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 1);
    assert.equal(response.body.data[0].payment_status, "worker_reject");
    assert.equal(response.body.data[0].riskText, "แผงปฏิเสธ รอชุดแรงงานแก้ยอด");
  });

  test("GET /api/admin/vehicle-jobs/history/daily-worker-income payment_status = admin_reject when a booth is REJECT and the worker was already released", async () => {
    const { token: adminToken } = await loginJobAdmin(99704);
    const worker = addWorker(99714);
    const job = addDispatchableJob(9974, 1);
    const ticket = addTicketForTicketJob(job.id, 199740);
    ticket.status = "REJECT";
    const assignment = addPendingAssignment(199741, job.id, worker.id);
    assignment.status = "RELEASED";
    assignment.scanned_at = new Date().toISOString();
    assignment.released_at = new Date().toISOString();

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

    const response = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/daily-worker-income",
      { token: adminToken },
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 1);
    assert.equal(response.body.data[0].payment_status, "admin_reject");
    assert.equal(response.body.data[0].riskText, "แผงปฏิเสธหลังปล่อยคิว/ต้องให้ Admin แก้");
  });

  test("GET /api/admin/vehicle-jobs/history/daily-worker-income payment_status = cancel reports the actor/reason of whoever cancelled the ticket_no (regression: cancelMarketJobById used to write no audit log at all)", async () => {
    const { token: adminToken } = await loginJobAdmin(99705);
    const worker = addWorker(99715);
    const job = addDispatchableJob(9975, 1);
    const ticket = addTicketForTicketJob(job.id, 199750);
    const market = state.marketJobs.find((item) => item.id === ticket.market_job_id)!;

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

    const cancelResponse = await server.request(
      "POST",
      "/api/admin/vehicle-jobs/assignment/cancel",
      {
        token: adminToken,
        body: {
          ticket_number: job.ticket_number,
          ticket_no: market.ticket_no,
          reason_code: "DUPLICATE_TICKET",
          reason_text: "Gate created this ticket twice.",
        },
      },
    );

    assert.equal(cancelResponse.status, 200, JSON.stringify(cancelResponse.body));

    const response = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/daily-worker-income",
      { token: adminToken },
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 1);

    const row = response.body.data[0];

    assert.equal(row.payment_status, "cancel");
    assert.ok(row.cancellation);
    assert.equal(row.cancellation.reason_code, undefined);
    assert.equal(row.cancellation.reason_text, undefined);
    assert.equal(row.cancellation.cancelled_by_type, "admin");
    assert.equal(row.cancellation.cancelled_by_name, "Admin 99705");
    assert.equal(row.riskText, "ตลาดนี้ถูกยกเลิก");
  });

  test("GET /api/admin/vehicle-jobs/history/daily-worker-income treats an empty shift query param as not filtering at all (regression: shift= used to coerce to 0 and fail validation)", async () => {
    const { token: adminToken } = await loginJobAdmin(96601);
    const workerA = addWorker(96602);
    const workerB = addWorker(96603);

    workerA.time_work = "Morning";
    workerB.time_work = "Evening";

    const jobA = addDispatchableJob(96604, 1);
    const ticketA = addTicketForTicketJob(jobA.id, 966050);
    const jobB = addDispatchableJob(96606, 1);
    const ticketB = addTicketForTicketJob(jobB.id, 966070);

    state.marketJobs.find((market) => market.id === ticketA.market_job_id)!.status =
      "COMPLETED";
    state.marketJobs.find((market) => market.id === ticketB.market_job_id)!.status =
      "COMPLETED";

    const now = new Date().toISOString();

    state.ticketWorkers.push(
      {
        id: state.nextTicketWorkerId++,
        market_job_id: ticketA.market_job_id,
        worker_id: workerA.id,
        status: "COMPLETED",
        final_earning_amount: "12.00",
        joined_at: now,
        cancelled_at: null,
        completed_at: now,
      },
      {
        id: state.nextTicketWorkerId++,
        market_job_id: ticketB.market_job_id,
        worker_id: workerB.id,
        status: "COMPLETED",
        final_earning_amount: "8.00",
        joined_at: now,
        cancelled_at: null,
        completed_at: now,
      },
    );

    // Postman/browser client มักส่ง shift= (string ว่าง) มาเมื่อ field ถูกติกไว้แต่ไม่ได้กรอกค่า —
    // ต้องถือว่าเหมือนไม่ได้ส่ง shift มาเลย (เห็นข้อมูลทุก shift) ไม่ใช่ coerce เป็น 0 แล้ว fail
    // validation (409 เดิม: "Too small: expected number to be >0")
    const response = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/daily-worker-income?shift=",
      { token: adminToken },
    );

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.length, 2);
  });
});

/* -------------------------------------- Daily Stall Fee Route Tests -------------------------------------- */

// Function เพิ่ม TicketProductFinancial ตรงๆ ลง state สำหรับ test รายงานค่าลงสินค้าแผงค้ารายวัน —
// เร็วกว่าไล่ submit+vendor-confirm จริงเวลาต้องการหลายแถว/หลายวันที่ควบคุม finalized_at เอง
function addTicketProductFinancial(
  id: number,
  ticketProductId: number,
  overrides: {
    confirmed_quantity?: string;
    stall_fee_rounded?: string;
    finalized_at?: string;
    shirt_color_snapshot?: string | null;
  } = {},
) {
  state.ticketProductFinancials.push({
    id,
    ticket_product_id: ticketProductId,
    confirmed_quantity: overrides.confirmed_quantity ?? "1.00",
    stall_fee_raw: "1.0000",
    stall_fee_rounded: overrides.stall_fee_rounded ?? "1.00",
    labor_fee_raw: "0.5000",
    product_charge: "1.50",
    worker_count: 1,
    worker_payout_total: "0.50",
    fund_amount: "0.0000",
    finalized_at: overrides.finalized_at ?? new Date().toISOString(),
    shirt_color_snapshot:
      overrides.shirt_color_snapshot === undefined ? "NAVY" : overrides.shirt_color_snapshot,
  });
}

describe("Daily Stall Fees", () => {
  test("GET /api/admin/vehicle-jobs/history/daily-stall-fees requires authentication", async () => {
    const response = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/daily-stall-fees?date_from=2026-08-01&date_to=2026-08-31",
    );

    assert.equal(response.status, 401);
  });

  test("GET /api/admin/vehicle-jobs/history/daily-stall-fees requires jobs:read permission", async () => {
    const passwordHash = await password.hashPassword("Admin@123456");
    const admin = addAdmin(96001, passwordHash);
    state.adminPermissions.set(admin.id, []);
    const login = await server.request("POST", "/api/auth/login", {
      body: { username: admin.username, password: "Admin@123456" },
    });

    const response = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/daily-stall-fees?date_from=2026-08-01&date_to=2026-08-31",
      { token: login.body.access_token },
    );

    assert.equal(response.status, 403);
  });

  test("GET /api/admin/vehicle-jobs/history/daily-stall-fees validates date_from/date_to", async () => {
    const { token } = await loginJobAdmin(96002);

    const missingDateTo = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/daily-stall-fees?date_from=2026-08-01",
      { token },
    );
    assert.equal(missingDateTo.status, 400);
    assert.equal(missingDateTo.body.code, "VALIDATION_ERROR");

    const badFormat = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/daily-stall-fees?date_from=2026/08/01&date_to=2026-08-31",
      { token },
    );
    assert.equal(badFormat.status, 400);
    assert.equal(badFormat.body.code, "VALIDATION_ERROR");

    const fromAfterTo = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/daily-stall-fees?date_from=2026-08-31&date_to=2026-08-01",
      { token },
    );
    assert.equal(fromAfterTo.status, 400);
    assert.equal(fromAfterTo.body.code, "VALIDATION_ERROR");

    const tooLong = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/daily-stall-fees?date_from=2026-08-01&date_to=2026-09-05",
      { token },
    );
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.code, "VALIDATION_ERROR");
    assert.equal(tooLong.body.validation_errors[0].field, "date_to");
  });

  test("GET /api/admin/vehicle-jobs/history/daily-stall-fees only shows finalized TicketProductFinancial rows, using persisted confirmed_quantity/stall_fee_rounded verbatim", async () => {
    const { token } = await loginJobAdmin(96010);
    const job = addDispatchableJob(9601, 1);
    const ticket = addTicketForTicketJob(job.id, 196010);
    // ticket.id * 10 + 2 (Cabbage) ไม่มี TicketProductFinancial เลย ต้องไม่โผล่ในรายงาน
    addTicketProductFinancial(960101, ticket.id * 10 + 1, {
      confirmed_quantity: "7.00",
      stall_fee_rounded: "28.00",
      finalized_at: bangkokDateToUtcIso("2026-08-15", 10),
    });

    const response = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/daily-stall-fees?date_from=2026-08-01&date_to=2026-08-31",
      { token },
    );

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.length, 1);
    const row = response.body.data[0];
    assert.equal(row.id, 960101);
    assert.equal(row.boothCode, ticket.boothCode);
    assert.equal(row.plate, job.license_plate);
    assert.equal(row.confirmed_quantity, "7.00");
    assert.equal(row.stall_fee_rounded, "28.00");
    assert.equal(row.business_date, "2026-08-15");
  });

  test("GET /api/admin/vehicle-jobs/history/daily-stall-fees uses Asia/Bangkok day boundaries for finalized_at, not UTC", async () => {
    const { token } = await loginJobAdmin(96011);
    const job = addDispatchableJob(9602, 1);
    const ticket = addTicketForTicketJob(job.id, 196020);

    // 2026-08-01 00:00 Asia/Bangkok = 2026-07-31 17:00 UTC — ต้องนับเป็นวันที่ 08-01 ตาม Bangkok
    addTicketProductFinancial(960201, ticket.id * 10 + 1, {
      finalized_at: bangkokDateToUtcIso("2026-08-01", 0),
    });
    // 2026-07-31 23:00 Asia/Bangkok — ก่อนช่วงเริ่มของ date_from=2026-08-01 ต้องไม่ถูกนับ
    addTicketProductFinancial(960202, ticket.id * 10 + 2, {
      finalized_at: bangkokDateToUtcIso("2026-07-31", 23),
    });

    const response = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/daily-stall-fees?date_from=2026-08-01&date_to=2026-08-01",
      { token },
    );

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.length, 1);
    assert.equal(response.body.data[0].id, 960201);
  });

  test("GET /api/admin/vehicle-jobs/history/daily-stall-fees supports multi-token search and exact product_code/package_code filters on Data, while available_products/available_packages stay faceted (each narrows only by the other dimension, never by itself)", async () => {
    const { token } = await loginJobAdmin(96012);
    const job = addDispatchableJob(9603, 1);
    const ticket = addTicketForTicketJob(job.id, 196030); // สร้าง product Apple/fruit และ Cabbage/vegetable ให้อัตโนมัติ
    const appleProductId = ticket.id * 10 + 1;
    const cabbageProductId = ticket.id * 10 + 2;
    const cabbageProductCode = state.ticketProducts.find((item) => item.id === cabbageProductId)!.productCode;

    addTicketProductFinancial(960301, appleProductId, {
      finalized_at: bangkokDateToUtcIso("2026-08-10", 10),
    });
    addTicketProductFinancial(960302, cabbageProductId, {
      finalized_at: bangkokDateToUtcIso("2026-08-10", 10),
    });

    // token "apple" + token ทะเบียนรถ (ตรงกันทั้งสองแถว) -> ต้อง AND กัน เหลือแค่แถว Apple
    const searchResponse = await server.request(
      "GET",
      `/api/admin/vehicle-jobs/history/daily-stall-fees?date_from=2026-08-01&date_to=2026-08-31&search=${encodeURIComponent(`${job.license_plate} apple`)}`,
      { token },
    );
    assert.equal(searchResponse.status, 200, JSON.stringify(searchResponse.body));
    assert.equal(searchResponse.body.data.length, 1);
    assert.equal(searchResponse.body.data[0].id, 960301);

    const productFilterResponse = await server.request(
      "GET",
      `/api/admin/vehicle-jobs/history/daily-stall-fees?date_from=2026-08-01&date_to=2026-08-31&product_code=${encodeURIComponent(cabbageProductCode)}`,
      { token },
    );
    assert.equal(productFilterResponse.status, 200, JSON.stringify(productFilterResponse.body));
    assert.equal(productFilterResponse.body.data.length, 1);
    assert.equal(productFilterResponse.body.data[0].id, 960302);
    // product_code ไม่ narrow available_products ของตัวเอง (ยังเห็นทั้ง Apple และ Cabbage)
    assert.equal(productFilterResponse.body.available_products.length, 2);
    // แต่ product_code=Cabbage ต้อง narrow available_packages เหลือแค่ "vegetable" ของ Cabbage
    assert.deepEqual(
      productFilterResponse.body.available_packages.map((item: { packageCode: string }) => item.packageCode),
      ["vegetable"],
    );
  });

  test("GET /api/admin/vehicle-jobs/history/daily-stall-fees summary reflects the full filtered set regardless of page/limit", async () => {
    const { token } = await loginJobAdmin(96013);
    const job = addDispatchableJob(9604, 1);
    const ticket = addTicketForTicketJob(job.id, 196040);

    addTicketProductFinancial(960401, ticket.id * 10 + 1, {
      confirmed_quantity: "5.00",
      stall_fee_rounded: "5.00",
      finalized_at: bangkokDateToUtcIso("2026-08-10", 9),
    });
    addTicketProductFinancial(960402, ticket.id * 10 + 2, {
      confirmed_quantity: "3.00",
      stall_fee_rounded: "3.00",
      finalized_at: bangkokDateToUtcIso("2026-08-10", 10),
    });

    const page1 = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/daily-stall-fees?date_from=2026-08-01&date_to=2026-08-31&page=1&limit=1",
      { token },
    );
    const page2 = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/daily-stall-fees?date_from=2026-08-01&date_to=2026-08-31&page=2&limit=1",
      { token },
    );

    assert.equal(page1.status, 200, JSON.stringify(page1.body));
    assert.equal(page1.body.data.length, 1);
    assert.equal(page2.body.data.length, 1);
    assert.notEqual(page1.body.data[0].id, page2.body.data[0].id);
    assert.deepEqual(page1.body.summary, page2.body.summary);
    assert.equal(page1.body.summary.row_count, 2);
    assert.equal(page1.body.summary.stall_count, 1);
    assert.equal(page1.body.summary.confirmed_quantity_total, "8.00");
    assert.equal(page1.body.summary.stall_fee_total, "8.00");
    assert.equal(page1.body.pagination.total, 2);
    assert.equal(page1.body.pagination.total_pages, 2);
  });

  test("GET /api/admin/vehicle-jobs/history/daily-stall-fees paginates stably (no duplicate/missing rows) when finalized_at ties", async () => {
    const { token } = await loginJobAdmin(96014);
    const job = addDispatchableJob(9605, 1);
    const ticket1 = addTicketForTicketJob(job.id, 196050, 296050);
    const ticket2 = addTicketForTicketJob(job.id, 196051, 296051);
    const sameFinalizedAt = bangkokDateToUtcIso("2026-08-12", 9);

    addTicketProductFinancial(960501, ticket1.id * 10 + 1, { finalized_at: sameFinalizedAt });
    addTicketProductFinancial(960502, ticket1.id * 10 + 2, { finalized_at: sameFinalizedAt });
    addTicketProductFinancial(960503, ticket2.id * 10 + 1, { finalized_at: sameFinalizedAt });

    const seenIds: number[] = [];
    for (const page of [1, 2, 3]) {
      const response = await server.request(
        "GET",
        `/api/admin/vehicle-jobs/history/daily-stall-fees?date_from=2026-08-01&date_to=2026-08-31&page=${page}&limit=1`,
        { token },
      );
      assert.equal(response.status, 200, JSON.stringify(response.body));
      seenIds.push(...response.body.data.map((row: { id: number }) => row.id));
    }

    assert.deepEqual([...seenIds].sort((a, b) => a - b), [960501, 960502, 960503]);
  });

  test("GET /api/admin/vehicle-jobs/history/daily-stall-fees reflects the real persisted TicketProductFinancial from a genuine submit+vendor-confirm finalize flow", async () => {
    const { token: adminToken } = await loginJobAdmin(96016);
    const { token: workerToken, worker } = await loginWorker(96017);
    const job = addDispatchableJob(9606, 1);
    job.tickets_closed_at = new Date().toISOString();
    const ticket = addTicketForTicketJob(job.id, 196060);
    const assignment = addPendingAssignment(196061, job.id, worker.id);
    assignment.status = "SCANNED";
    assignment.accepted_at = new Date().toISOString();
    assignment.scanned_at = new Date().toISOString();
    state.connectedWorkers.add(worker.id);
    await workerQueue.markWorkerAssigned(worker.id);

    const products = state.ticketProducts.filter((product) => product.ticket_id === ticket.id);
    const market = state.marketJobs.find((item) => item.id === ticket.market_job_id)!;

    const submitResponse = await server.request(
      "POST",
      "/api/workers/me/assignments/tickets/complete",
      {
        token: workerToken,
        body: {
          ticket_no: market.ticket_no,
          boothCode: ticket.boothCode,
          items: products.map((product, index) => ({
            productCode: product.productCode,
            packageCode: product.packageCode,
            confirmed_quantity: index === 0 ? 10 : 4,
          })),
        },
      },
    );
    assert.equal(submitResponse.status, 200);

    workerDispatch.startAssignmentTimeoutProcessing();
    const queueName = process.env.BULLMQ_ASSIGNMENT_TIMEOUT_QUEUE as string;
    const processor = state.workerProcessors.get(queueName);
    const submission = state.completionSubmissions.at(-1);
    assert.ok(submission);

    await processor!({
      data: { ticketId: ticket.id, submissionId: submission.id, kind: "vendor_confirm" },
    });

    const financials = state.ticketProductFinancials.filter((item) =>
      products.some((product) => product.id === item.ticket_product_id),
    );
    assert.equal(financials.length, 2);

    const today = bangkokDateKey();
    const response = await server.request(
      "GET",
      `/api/admin/vehicle-jobs/history/daily-stall-fees?date_from=${today}&date_to=${today}`,
      { token: adminToken },
    );

    assert.equal(response.status, 200, JSON.stringify(response.body));
    const rows = response.body.data.filter((row: { id: number }) =>
      financials.some((financial) => financial.id === row.id),
    );
    assert.equal(rows.length, 2);

    for (const financial of financials) {
      const row = rows.find((item: { id: number }) => item.id === financial.id);

      assert.ok(row);
      // ค่าจริงที่ persist ไว้ตอน finalize อาจไม่มี trailing zero ("10" แทน "10.00") — endpoint ต้อง
      // format เป็น decimal string 2 ตำแหน่งเสมอ แต่ต้องเป็น "ค่าเดียวกัน" ไม่ใช่คำนวณใหม่
      assert.equal(Number(row.confirmed_quantity), Number(financial.confirmed_quantity));
      assert.equal(Number(row.stall_fee_rounded), Number(financial.stall_fee_rounded));
      assert.equal(row.plate, job.license_plate);
      assert.equal(row.boothCode, ticket.boothCode);
      assert.equal(row.ticket_no, market.ticket_no);
    }
  });
});

/* -------------------------------------- Monthly Stall Fee Route Tests -------------------------------------- */

describe("Monthly Stall Fees", () => {
  test("GET /api/admin/vehicle-jobs/history/monthly-stall-fees requires authentication", async () => {
    const response = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/monthly-stall-fees?date_from=2026-12-01&date_to=2027-01-31",
    );

    assert.equal(response.status, 401);
  });

  test("GET /api/admin/vehicle-jobs/history/monthly-stall-fees requires jobs:read permission", async () => {
    const passwordHash = await password.hashPassword("Admin@123456");
    const admin = addAdmin(97300, passwordHash);
    state.adminPermissions.set(admin.id, []);
    const login = await server.request("POST", "/api/auth/login", {
      body: { username: admin.username, password: "Admin@123456" },
    });

    const response = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/monthly-stall-fees?date_from=2026-12-01&date_to=2027-01-31",
      { token: login.body.access_token },
    );

    assert.equal(response.status, 403);
  });

  test("GET /api/admin/vehicle-jobs/history/monthly-stall-fees validates date_from/date_to, but allows crossing months/years and rejects only when the range exceeds 6 calendar months", async () => {
    const { token } = await loginJobAdmin(97301);

    const missingDateTo = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/monthly-stall-fees?date_from=2026-12-01",
      { token },
    );
    assert.equal(missingDateTo.status, 400);
    assert.equal(missingDateTo.body.code, "VALIDATION_ERROR");

    const badFormat = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/monthly-stall-fees?date_from=2026/12/01&date_to=2027-01-31",
      { token },
    );
    assert.equal(badFormat.status, 400);
    assert.equal(badFormat.body.code, "VALIDATION_ERROR");

    const fromAfterTo = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/monthly-stall-fees?date_from=2027-01-31&date_to=2026-12-01",
      { token },
    );
    assert.equal(fromAfterTo.status, 400);
    assert.equal(fromAfterTo.body.code, "VALIDATION_ERROR");

    // ข้ามเดือน/ข้ามปีต้องผ่านได้ปกติ (ไม่ใช่ cap แบบ daily-stall-fees ที่บังคับเดือนเดียว)
    const crossYear = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/monthly-stall-fees?date_from=2026-12-01&date_to=2027-01-31",
      { token },
    );
    assert.equal(crossYear.status, 200, JSON.stringify(crossYear.body));

    // ข้ามปีอธิกสุรทิน (2028 เป็นปีอธิกสุรทิน มี 29 ก.พ.) ต้องผ่านได้ปกติเช่นกัน
    const leapYear = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/monthly-stall-fees?date_from=2028-02-01&date_to=2028-02-29",
      { token },
    );
    assert.equal(leapYear.status, 200, JSON.stringify(leapYear.body));

    // เกิน 6 เดือนปฏิทินนับจาก date_from (2026-12-01 + 6 เดือน = 2027-06-01) ต้อง reject
    const tooLong = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/monthly-stall-fees?date_from=2026-12-01&date_to=2027-06-02",
      { token },
    );
    assert.equal(tooLong.status, 400);
    assert.equal(tooLong.body.code, "VALIDATION_ERROR");
    assert.equal(tooLong.body.validation_errors[0].field, "date_to");

    // พอดี 6 เดือนเป๊ะต้องผ่าน (ขอบเขตต้อง inclusive)
    const exactlySixMonths = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/monthly-stall-fees?date_from=2026-12-01&date_to=2027-06-01",
      { token },
    );
    assert.equal(exactlySixMonths.status, 200, JSON.stringify(exactlySixMonths.body));
  });

  test("GET /api/admin/vehicle-jobs/history/monthly-stall-fees uses Asia/Bangkok day boundaries for finalized_at, not UTC, across a month boundary", async () => {
    const { token } = await loginJobAdmin(97302);
    const job = addDispatchableJob(97302, 1);
    const ticket = addTicketForTicketJob(job.id, 197302);

    // 2027-01-01 00:00 Asia/Bangkok = 2026-12-31 17:00 UTC — ต้องนับเป็นเดือน ม.ค. ตาม Bangkok ไม่ใช่
    // ธ.ค. ตาม UTC
    addTicketProductFinancial(973021, ticket.id * 10 + 1, {
      finalized_at: bangkokDateToUtcIso("2027-01-01", 0),
    });
    // 2026-12-31 23:00 Asia/Bangkok — ก่อนช่วงเริ่มของ date_from=2027-01-01 ต้องไม่ถูกนับ
    addTicketProductFinancial(973022, ticket.id * 10 + 2, {
      finalized_at: bangkokDateToUtcIso("2026-12-31", 23),
    });

    const response = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/monthly-stall-fees?date_from=2027-01-01&date_to=2027-01-31",
      { token },
    );

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.summary.financialItemCount, 1);
  });

  test("GET /api/admin/vehicle-jobs/history/monthly-stall-fees groups by market_code+booth_code+shirt_color, summing stall_fee_rounded and counting financial_item_count, without merging across different markets", async () => {
    const { token } = await loginJobAdmin(97303);
    const job = addDispatchableJob(97303, 1);
    const marketA = addMarketJobForVehicle(job.id, { id: 973031, marketCode: "MKT-A", ticket_no: "TICKET-97303-A" });
    const marketB = addMarketJobForVehicle(job.id, { id: 973032, marketCode: "MKT-B", ticket_no: "TICKET-97303-B" });
    const ticketA = addTicketForTicketJob(job.id, 973033, marketA.id);
    // แผงเลขเดียวกัน ("STALL-973033" ชื่อ auto จาก ticketId) แต่คนละ TicketNumber จึงคนละ BoothJob
    // จริง — ทดสอบว่าคนละ market_code ต้องไม่ถูกรวมเข้าด้วยกันแม้ boothCode จะบังเอิญซ้ำ
    const ticketB = addTicketForTicketJob(job.id, 973034, marketB.id);
    ticketB.boothCode = ticketA.boothCode;

    // สอง product ของ ticketA (แผงเดียวกัน ตลาดเดียวกัน สีเดียวกัน) ต้องถูกรวมยอดเป็นกลุ่มเดียว
    addTicketProductFinancial(973035, ticketA.id * 10 + 1, {
      stall_fee_rounded: "100.00",
      finalized_at: bangkokDateToUtcIso("2026-12-05", 10),
      shirt_color_snapshot: "NAVY",
    });
    addTicketProductFinancial(973036, ticketA.id * 10 + 2, {
      stall_fee_rounded: "50.00",
      finalized_at: bangkokDateToUtcIso("2026-12-06", 10),
      shirt_color_snapshot: "NAVY",
    });
    // ticketB บูธเลขเดียวกันแต่คนละตลาด ต้องแยกเป็นอีกแถวหนึ่งเสมอ
    addTicketProductFinancial(973037, ticketB.id * 10 + 1, {
      stall_fee_rounded: "30.00",
      finalized_at: bangkokDateToUtcIso("2026-12-05", 10),
      shirt_color_snapshot: "NAVY",
    });

    const response = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/monthly-stall-fees?date_from=2026-12-01&date_to=2026-12-31",
      { token },
    );

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.length, 2);

    const rowA = response.body.data.find((row: { marketCode: string }) => row.marketCode === "MKT-A");
    const rowB = response.body.data.find((row: { marketCode: string }) => row.marketCode === "MKT-B");

    assert.ok(rowA);
    assert.ok(rowB);
    assert.equal(rowA.boothCode, ticketA.boothCode);
    assert.equal(rowA.shirtColor, "NAVY");
    assert.equal(rowA.financialItemCount, 2);
    assert.equal(rowA.debitAmount, "150.00");
    assert.equal(rowA.id, `2026-12-01:2026-12-31|MKT-A|${ticketA.boothCode}|NAVY`);
    assert.equal(rowB.financialItemCount, 1);
    assert.equal(rowB.debitAmount, "30.00");

    assert.equal(response.body.summary.row_count, 2);
    assert.equal(response.body.summary.stall_count, 2);
    assert.equal(response.body.summary.financialItemCount, 3);
    assert.equal(response.body.summary.debitAmountTotal, "180.00");
    assert.deepEqual(response.body.period, { date_from: "2026-12-01", date_to: "2026-12-31" });
  });

  test("GET /api/admin/vehicle-jobs/history/monthly-stall-fees classifies shirt_color as MIXED when workers on the same booth have different labor colors, and UNKNOWN for legacy rows with no snapshot", async () => {
    const { token } = await loginJobAdmin(97304);
    const job = addDispatchableJob(97304, 1);
    const ticket = addTicketForTicketJob(job.id, 197304);

    addTicketProductFinancial(973041, ticket.id * 10 + 1, {
      finalized_at: bangkokDateToUtcIso("2026-12-10", 10),
      shirt_color_snapshot: "MIXED",
    });
    // แถวเก่าก่อนมีฟีเจอร์นี้ — ไม่มี shirt_color_snapshot เลย (null) ต้องแสดงเป็น UNKNOWN
    addTicketProductFinancial(973042, ticket.id * 10 + 2, {
      finalized_at: bangkokDateToUtcIso("2026-12-11", 10),
      shirt_color_snapshot: null,
    });

    const response = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/monthly-stall-fees?date_from=2026-12-01&date_to=2026-12-31",
      { token },
    );

    assert.equal(response.status, 200, JSON.stringify(response.body));
    const colors = response.body.data.map((row: { shirtColor: string }) => row.shirtColor).sort();
    assert.deepEqual(colors, ["MIXED", "UNKNOWN"]);
  });

  test("GET /api/admin/vehicle-jobs/history/monthly-stall-fees end-to-end: a genuine finalize with two workers of different labor_color classifies MIXED for real, and reconciles its total with daily-stall-fees for the same period", async () => {
    const { token: adminToken } = await loginJobAdmin(97305);
    const { token: worker1Token, worker: worker1 } = await loginWorker(97306);
    const { token: worker2Token, worker: worker2 } = await loginWorker(97307);
    worker1.labor_color = "NAVY";
    worker2.labor_color = "BLUE";

    const job = addDispatchableJob(97305, 2);
    job.tickets_closed_at = new Date().toISOString();
    const ticket = addTicketForTicketJob(job.id, 197305);
    const assignment1 = addPendingAssignment(197306, job.id, worker1.id);
    assignment1.status = "SCANNED";
    assignment1.accepted_at = new Date().toISOString();
    assignment1.scanned_at = new Date().toISOString();
    const assignment2 = addPendingAssignment(197307, job.id, worker2.id);
    assignment2.status = "SCANNED";
    assignment2.accepted_at = new Date().toISOString();
    assignment2.scanned_at = new Date().toISOString();
    state.connectedWorkers.add(worker1.id);
    state.connectedWorkers.add(worker2.id);
    await workerQueue.markWorkerAssigned(worker1.id);
    await workerQueue.markWorkerAssigned(worker2.id);

    const products = state.ticketProducts.filter((product) => product.ticket_id === ticket.id);
    const market = state.marketJobs.find((item) => item.id === ticket.market_job_id)!;

    const submitResponse = await server.request(
      "POST",
      "/api/workers/me/assignments/tickets/complete",
      {
        token: worker1Token,
        body: {
          ticket_no: market.ticket_no,
          boothCode: ticket.boothCode,
          items: products.map((product, index) => ({
            productCode: product.productCode,
            packageCode: product.packageCode,
            confirmed_quantity: index === 0 ? 10 : 4,
          })),
        },
      },
    );
    assert.equal(submitResponse.status, 200, JSON.stringify(submitResponse.body));
    void worker2Token;

    workerDispatch.startAssignmentTimeoutProcessing();
    const queueName = process.env.BULLMQ_ASSIGNMENT_TIMEOUT_QUEUE as string;
    const processor = state.workerProcessors.get(queueName);
    const submission = state.completionSubmissions.at(-1);
    assert.ok(submission);

    await processor!({
      data: { ticketId: ticket.id, submissionId: submission.id, kind: "vendor_confirm" },
    });

    const financials = state.ticketProductFinancials.filter((item) =>
      products.some((product) => product.id === item.ticket_product_id),
    );
    assert.equal(financials.length, 2);
    // ยืนยันว่า finalize จริง (ไม่ใช่ fixture มือ) คำนวณ MIXED ให้เองจริงจาก labor_color ของ worker
    // สองคนที่ต่างกัน
    for (const financial of financials) {
      assert.equal((financial as { shirt_color_snapshot?: string }).shirt_color_snapshot, "MIXED");
    }

    const today = bangkokDateKey();
    const [monthlyResponse, dailyResponse] = await Promise.all([
      server.request(
        "GET",
        `/api/admin/vehicle-jobs/history/monthly-stall-fees?date_from=${today}&date_to=${today}`,
        { token: adminToken },
      ),
      server.request(
        "GET",
        `/api/admin/vehicle-jobs/history/daily-stall-fees?date_from=${today}&date_to=${today}`,
        { token: adminToken },
      ),
    ]);

    assert.equal(monthlyResponse.status, 200, JSON.stringify(monthlyResponse.body));
    assert.equal(dailyResponse.status, 200, JSON.stringify(dailyResponse.body));

    const dailyTotalForThisBooth = dailyResponse.body.data
      .filter((row: { id: number }) => financials.some((financial) => financial.id === row.id))
      .reduce((sum: number, row: { stall_fee_rounded: string }) => sum + Number(row.stall_fee_rounded), 0);
    const monthlyRow = monthlyResponse.body.data.find(
      (row: { marketCode: string; boothCode: string }) =>
        row.marketCode === market.marketCode && row.boothCode === ticket.boothCode,
    );

    assert.ok(monthlyRow);
    assert.equal(monthlyRow.shirtColor, "MIXED");
    assert.equal(Number(monthlyRow.debitAmount), dailyTotalForThisBooth);
  });

  test("GET /api/admin/vehicle-jobs/history/monthly-stall-fees summary reflects the full filtered set regardless of page/limit, and pagination totals count groups not raw financial rows", async () => {
    const { token } = await loginJobAdmin(97309);
    const job = addDispatchableJob(97309, 1);
    const ticket = addTicketForTicketJob(job.id, 197309);

    addTicketProductFinancial(973091, ticket.id * 10 + 1, {
      stall_fee_rounded: "20.00",
      finalized_at: bangkokDateToUtcIso("2026-12-05", 9),
      shirt_color_snapshot: "NAVY",
    });
    // แถวที่สองอยู่กลุ่มเดียวกับแถวแรก (booth/market/color เดียวกัน) ต้องรวมเป็น 1 แถวใน data แต่
    // financial_item_count/summary ต้องยังนับ 2 รายการ
    addTicketProductFinancial(973092, ticket.id * 10 + 2, {
      stall_fee_rounded: "15.00",
      finalized_at: bangkokDateToUtcIso("2026-12-06", 9),
      shirt_color_snapshot: "NAVY",
    });

    const response = await server.request(
      "GET",
      "/api/admin/vehicle-jobs/history/monthly-stall-fees?date_from=2026-12-01&date_to=2026-12-31&page=1&limit=1",
      { token },
    );

    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.data.length, 1);
    assert.equal(response.body.data[0].financialItemCount, 2);
    assert.equal(response.body.data[0].debitAmount, "35.00");
    assert.equal(response.body.summary.row_count, 1);
    assert.equal(response.body.summary.stall_count, 1);
    assert.equal(response.body.summary.financialItemCount, 2);
    assert.equal(response.body.summary.debitAmountTotal, "35.00");
    assert.equal(response.body.pagination.total, 1);
    assert.equal(response.body.pagination.total_pages, 1);
  });
});

/* -------------------------------------- Worker Queue Route Tests -------------------------------------- */
