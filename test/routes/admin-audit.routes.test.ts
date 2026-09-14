import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { addAdmin, addDispatchableJob, addGateClient, addPendingAssignment, addTicketForTicketJob, addWorker, getPassword, getTicketFinancialService, getWorkerDispatch, getWorkerQueue, resetRouteTestState, restoreRouteTestLoader, startRouteTestServer, state, type TestServer } from "../helpers/app-test-harness";

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

// Function เธชเธฃเนเธฒเธ gate vehicle job body เธชเธณเธซเธฃเธฑเธ test
function buildBoothJobJobBody(suffix: string) {
  return {
    TicketNo: `TKT-20260723-${suffix}`,
    TicketCreatedAt: "2026-07-23T14:30:00+07:00",
    BoothCount: 1,
    MarketCode: `MARKET-${suffix}`,
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

// Function เตรียมการ login job admin ที่มี audit:read เพิ่มจาก loginJobAdmin — ใช้เจาะจงกับ test
// ของ SecurityAuditLog quick filter/visibility (27.12) เพราะ event กลุ่มนี้ sensitive กว่า event เดิม
async function loginAuditAdmin(accountId: number): Promise<{ token: string }> {
  const passwordHash = await password.hashPassword("Admin@123456");
  const admin = addAdmin(accountId, passwordHash);
  state.adminPermissions.set(admin.id, ["jobs:read", "audit:read"]);

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

function addAuditAssignment(input: {
  id: number;
  workerId: number;
  ticketJobId: number;
  createdAt: string;
  status?: string;
  acceptedAt?: string | null;
  scannedAt?: string | null;
  completedAt?: string | null;
  events?: string[];
}) {
  const assignment = {
    id: input.id,
    vehicle_job_id: input.ticketJobId,
    worker_id: input.workerId,
    status: input.status ?? "PENDING",
    accept_deadline_at: null,
    scan_deadline_at: null,
    accepted_at: input.acceptedAt ?? null,
    scanned_at: input.scannedAt ?? null,
    completed_at: input.completedAt ?? null,
    created_at: input.createdAt,
    updated_at: input.completedAt ?? input.createdAt,
  };

  state.assignments.push(assignment);
  for (const eventType of input.events ?? []) {
    state.workerAssignmentEvents.push({
      id: state.nextWorkerAssignmentEventId++,
      assignment_id: assignment.id,
      worker_id: assignment.worker_id,
      vehicle_job_id: assignment.vehicle_job_id,
      event_type: eventType,
      occurred_at: assignment.updated_at,
      metadata: null,
      created_at: assignment.updated_at,
    });
  }

  return assignment;
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

/* -------------------------------------- Gate Route Tests -------------------------------------- */

test("GET /api/admin/audit/workers/performance aggregates today's Bangkok assignment cohort", async () => {
  const { token } = await loginJobAdmin(12001);
  const today = bangkokDateKey();
  const todayAt = bangkokDateToUtcIso(today, 1);
  const yesterdayAt = new Date(new Date(`${today}T00:00:00.000+07:00`).getTime() - 60_000).toISOString();
  const workerA = addWorker(12002, "hash");
  const workerB = addWorker(12003, "hash");
  const workerNull = addWorker(12004, "hash");
  addDispatchableJob(120020, 1);
  addDispatchableJob(120030, 1);
  addDispatchableJob(120040, 1);

  addAuditAssignment({
    id: 1200201,
    workerId: workerA.id,
    ticketJobId: 120020,
    createdAt: todayAt,
    status: "COMPLETED",
    acceptedAt: todayAt,
    scannedAt: todayAt,
    completedAt: todayAt,
    events: ["ACCEPTED", "COMPLETED"],
  });
  addAuditAssignment({
    id: 1200202,
    workerId: workerA.id,
    ticketJobId: 120020,
    createdAt: todayAt,
    status: "TIMEOUT",
  });
  addAuditAssignment({
    id: 1200203,
    workerId: workerA.id,
    ticketJobId: 120020,
    createdAt: todayAt,
    status: "TIMEOUT",
    acceptedAt: todayAt,
    events: ["SCAN_TIMEOUT"],
  });
  addAuditAssignment({
    id: 1200301,
    workerId: workerB.id,
    ticketJobId: 120030,
    createdAt: todayAt,
    status: "COMPLETED",
    acceptedAt: todayAt,
    scannedAt: todayAt,
    completedAt: todayAt,
  });
  addAuditAssignment({
    id: 1200302,
    workerId: workerB.id,
    ticketJobId: 120030,
    createdAt: todayAt,
    status: "ACCEPTED",
    acceptedAt: todayAt,
  });
  addAuditAssignment({
    id: 1200401,
    workerId: workerNull.id,
    ticketJobId: 120040,
    createdAt: todayAt,
    status: "CANCELLED",
    events: ["ADMIN_CANCELLED"],
  });
  addAuditAssignment({
    id: 1200999,
    workerId: workerB.id,
    ticketJobId: 120030,
    createdAt: yesterdayAt,
    status: "TIMEOUT",
  });

  const response = await server.request(
    "GET",
    "/api/admin/audit/workers/performance",
    { token }
  );

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.period, {
    date_from: today,
    date_to: today,
    timezone: "Asia/Bangkok",
  });
  assert.deepEqual(response.body.pagination, {
    page: 1,
    limit: 20,
    total: 3,
    total_pages: 1,
  });
  assert.equal(response.body.data[0].worker_code, workerB.labor_code);
  assert.equal(response.body.data[0].acceptRate, "100.00");
  assert.equal(response.body.data[1].worker_code, workerA.labor_code);
  assert.equal(response.body.data[1].totalAssignedJobCount, 3);
  assert.equal(response.body.data[1].acceptedJobCount, 2);
  assert.equal(response.body.data[1].acceptTimeoutJobCount, 1);
  assert.equal(response.body.data[1].scanTimeoutJobCount, 1);
  assert.equal(response.body.data[1].completed_job_count, 1);
  assert.equal(response.body.data[1].acceptRate, "66.67");
  assert.equal(response.body.data[2].worker_code, workerNull.labor_code);
  assert.equal(response.body.data[2].adminCancelledJobCount, 1);
  assert.equal(response.body.data[2].acceptRate, null);
  assert.equal("issue_count" in response.body.data[0], false);
  assert.equal("completionRate" in response.body.data[0], false);
  assert.equal("earnings" in response.body.data[0], false);
});

test("GET /api/admin/audit/workers/performance supports date range, worker filter, sorting, and pagination after aggregate", async () => {
  const { token } = await loginJobAdmin(12101);
  const workerA = addWorker(12102, "hash");
  const workerB = addWorker(12103, "hash");
  const workerNoHistory = addWorker(12104, "hash");
  addDispatchableJob(121020, 1);
  addDispatchableJob(121030, 1);
  const rangeAt = bangkokDateToUtcIso("2026-08-15", 10);
  const outsideAt = bangkokDateToUtcIso("2026-09-01", 1);

  addAuditAssignment({
    id: 1210201,
    workerId: workerA.id,
    ticketJobId: 121020,
    createdAt: rangeAt,
    status: "TIMEOUT",
  });
  addAuditAssignment({
    id: 1210202,
    workerId: workerA.id,
    ticketJobId: 121020,
    createdAt: rangeAt,
    status: "TIMEOUT",
    acceptedAt: rangeAt,
  });
  addAuditAssignment({
    id: 1210301,
    workerId: workerB.id,
    ticketJobId: 121030,
    createdAt: rangeAt,
    status: "COMPLETED",
    acceptedAt: rangeAt,
    completedAt: rangeAt,
  });
  addAuditAssignment({
    id: 1210302,
    workerId: workerB.id,
    ticketJobId: 121030,
    createdAt: outsideAt,
    status: "COMPLETED",
    acceptedAt: outsideAt,
    completedAt: outsideAt,
  });

  const filtered = await server.request(
    "GET",
    `/api/admin/audit/workers/performance?worker_code=${workerA.labor_code}&date_from=2026-08-01&date_to=2026-08-31`,
    { token }
  );

  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.pagination.total, 1);
  assert.equal(filtered.body.data[0].worker_code, workerA.labor_code);
  assert.equal(filtered.body.data[0].totalAssignedJobCount, 2);
  assert.equal(filtered.body.data[0].scanTimeoutJobCount, 1);
  assert.equal(filtered.body.data[0].acceptRate, "50.00");

  const sorted = await server.request(
    "GET",
    "/api/admin/audit/workers/performance?date_from=2026-08-01&date_to=2026-08-31&sort_by=total_assigned&sort_order=asc&page=1&limit=1",
    { token }
  );

  assert.equal(sorted.status, 200);
  assert.equal(sorted.body.pagination.total, 2);
  assert.equal(sorted.body.pagination.total_pages, 2);
  assert.equal(sorted.body.data.length, 1);
  assert.notEqual(sorted.body.data[0].worker_code, workerNoHistory.labor_code);
});

test("GET /api/admin/audit/workers/performance keeps total on empty pages beyond the last page", async () => {
  const { token } = await loginJobAdmin(12401);
  const date = "2026-08-20";
  const createdAt = bangkokDateToUtcIso(date, 9);

  for (let index = 0; index < 25; index += 1) {
    const worker = addWorker(12402 + index, "hash");
    const ticketJobId = 124020 + index;

    addDispatchableJob(ticketJobId, 1);
    addAuditAssignment({
      id: 1240200 + index,
      workerId: worker.id,
      ticketJobId,
      createdAt,
      status: "COMPLETED",
      acceptedAt: createdAt,
      scannedAt: createdAt,
      completedAt: createdAt,
      events: ["ACCEPTED", "COMPLETED"],
    });
  }

  const pageTwo = await server.request(
    "GET",
    `/api/admin/audit/workers/performance?date_from=${date}&date_to=${date}&page=2&limit=20`,
    { token },
  );

  assert.equal(pageTwo.status, 200);
  assert.deepEqual(pageTwo.body.pagination, {
    page: 2,
    limit: 20,
    total: 25,
    total_pages: 2,
  });
  assert.equal(pageTwo.body.data.length, 5);

  const pageThree = await server.request(
    "GET",
    `/api/admin/audit/workers/performance?date_from=${date}&date_to=${date}&page=3&limit=20`,
    { token },
  );

  assert.equal(pageThree.status, 200);
  assert.deepEqual(pageThree.body.pagination, {
    page: 3,
    limit: 20,
    total: 25,
    total_pages: 2,
  });
  assert.deepEqual(pageThree.body.data, []);
});

test("GET /api/admin/audit/workers/performance validates date pairs and sort whitelist", async () => {
  const { token } = await loginJobAdmin(12201);

  for (const query of [
    "date_from=2026-08-01",
    "date_to=2026-08-31",
    "date_from=2026-09-01&date_to=2026-08-31",
    "sort_by=issue_count",
    "sort_order=sideways",
  ]) {
    const response = await server.request(
      "GET",
      `/api/admin/audit/workers/performance?${query}`,
      { token }
    );

    assert.equal(response.status, 400);
    assert.equal(response.body.code, "VALIDATION_ERROR");
  }
});

test("GET /api/admin/audit/workers/performance rejects a date range longer than 92 days", async () => {
  const { token } = await loginJobAdmin(12202);

  const response = await server.request(
    "GET",
    "/api/admin/audit/workers/performance?date_from=2026-01-01&date_to=2026-12-31",
    { token }
  );

  assert.equal(response.status, 400);
  assert.equal(response.body.code, "VALIDATION_ERROR");
});

test("GET /api/admin/audit/workers/performance requires admin jobs:read permission", async () => {
  const unauthenticated = await server.request(
    "GET",
    "/api/admin/audit/workers/performance"
  );

  assert.equal(unauthenticated.status, 401);

  const workerLogin = await loginWorker(12301);
  const workerResponse = await server.request(
    "GET",
    "/api/admin/audit/workers/performance",
    { token: workerLogin.token }
  );

  assert.equal(workerResponse.status, 403);

  const passwordHash = await password.hashPassword("Admin@123456");
  const admin = addAdmin(12302, passwordHash);
  state.adminPermissions.set(admin.id, []);
  const login = await server.request("POST", "/api/auth/login", {
    body: {
      username: admin.username,
      password: "Admin@123456",
    },
  });

  assert.equal(login.status, 200);
  const forbidden = await server.request(
    "GET",
    "/api/admin/audit/workers/performance",
    { token: login.body.access_token }
  );

  assert.equal(forbidden.status, 403);
});

/* -------------------------------------- Audit Events Tests -------------------------------------- */

test("GET /api/admin/audit/events maps an AdminActionLog row via the action_type table, deriving admin_override + metadata.action for OVERRIDE_COUNT", async () => {
  const { token } = await loginJobAdmin(13001);
  const today = bangkokDateKey();
  const occurredAt = bangkokDateToUtcIso(today, 5);
  const job = addDispatchableJob(130010, 1);
  job.created_at = bangkokDateToUtcIso(today, 1);

  state.adminActionLogs.push({
    id: state.nextAdminActionLogId++,
    vehicle_job_id: job.id,
    gate_ticket_id: null,
    market_job_id: null,
    action_type: "OVERRIDE_COUNT",
    reason_code: "COUNT_MISMATCH",
    reason_text: "นับใหม่",
    actor_account_id: 13001,
    metadata: { counts: [] },
    created_at: occurredAt,
  });

  const response = await server.request(
    "GET",
    `/api/admin/audit/events?date_from=${today}&date_to=${today}`,
    { token }
  );

  assert.equal(response.status, 200);

  const event = response.body.data.find(
    (item: { event_type: string }) => item.event_type === "admin_override"
  );

  assert.ok(event);
  assert.equal(event.actor_type, "admin");
  assert.equal(event.actor_id, "13001");
  assert.equal(event.vehicle_job_id, String(job.id));
  assert.equal(event.reason_code, "COUNT_MISMATCH");
  assert.equal(event.reason_text, "นับใหม่");
  assert.equal(event.metadata.action, "override_count");
});

test("GET /api/admin/audit/events merges WorkerAssignmentEvent.ADMIN_CANCELLED with the matching AdminActionLog.ASSIGNMENT_CANCELLED into a single worker_assignment_cancelled event (regression: must not return both rows)", async () => {
  const { token } = await loginJobAdmin(13101);
  const today = bangkokDateKey();
  const occurredAt = bangkokDateToUtcIso(today, 5);
  const worker = addWorker(13102);
  const job = addDispatchableJob(131010, 1);
  job.created_at = bangkokDateToUtcIso(today, 1);

  const assignment = addAuditAssignment({
    id: 1310101,
    workerId: worker.id,
    ticketJobId: job.id,
    createdAt: bangkokDateToUtcIso(today, 1),
    status: "CANCELLED",
    acceptedAt: bangkokDateToUtcIso(today, 2),
  });

  state.workerAssignmentEvents.push({
    id: state.nextWorkerAssignmentEventId++,
    assignment_id: assignment.id,
    worker_id: worker.id,
    vehicle_job_id: job.id,
    event_type: "ADMIN_CANCELLED",
    occurred_at: occurredAt,
    metadata: null,
    created_at: occurredAt,
  });

  state.adminActionLogs.push({
    id: state.nextAdminActionLogId++,
    vehicle_job_id: job.id,
    gate_ticket_id: null,
    market_job_id: null,
    action_type: "ASSIGNMENT_CANCELLED",
    reason_code: "replacement",
    reason_text: "สลับคนแทน",
    actor_account_id: 13101,
    metadata: {
      assignment_id: assignment.id,
      worker_id: worker.id,
      worker_code: worker.labor_code,
    },
    created_at: occurredAt,
  });

  const response = await server.request(
    "GET",
    `/api/admin/audit/events?date_from=${today}&date_to=${today}`,
    { token }
  );

  assert.equal(response.status, 200);

  const cancelEvents = response.body.data.filter(
    (item: { event_type: string }) => item.event_type === "worker_assignment_cancelled"
  );

  assert.equal(cancelEvents.length, 1);
  assert.ok(cancelEvents[0].event_id.startsWith("worker_assignment_event:"));
  assert.equal(cancelEvents[0].actor_type, "admin");
  assert.equal(cancelEvents[0].actor_id, "13101");
  assert.equal(cancelEvents[0].reason_code, "replacement");
  assert.equal(cancelEvents[0].reason_text, "สลับคนแทน");
  assert.equal(cancelEvents[0].assignment_id, String(assignment.id));

  const adminActionEvents = response.body.data.filter(
    (item: { event_id: string }) => item.event_id.startsWith("admin_action:")
  );

  assert.equal(
    adminActionEvents.length,
    0,
    "The ASSIGNMENT_CANCELLED AdminActionLog row must not also appear as its own separate event."
  );
});

test("GET /api/admin/audit/events suppresses the WorkerAssignmentEvent.ASSIGNED row for assignments listed in a MANUAL_ASSIGNMENT log's metadata.assignment_ids, returning the Manual Assign admin_override event as the sole event instead", async () => {
  const { token } = await loginJobAdmin(13201);
  const today = bangkokDateKey();
  const occurredAt = bangkokDateToUtcIso(today, 5);
  const worker = addWorker(13202);
  const job = addDispatchableJob(132010, 1);
  job.created_at = bangkokDateToUtcIso(today, 1);
  const assignmentId = 1320101;

  state.assignments.push({
    id: assignmentId,
    vehicle_job_id: job.id,
    worker_id: worker.id,
    status: "PENDING",
    accept_deadline_at: null,
    scan_deadline_at: null,
    accepted_at: null,
    scanned_at: null,
    completed_at: null,
    created_at: occurredAt,
    updated_at: occurredAt,
  });

  state.workerAssignmentEvents.push({
    id: state.nextWorkerAssignmentEventId++,
    assignment_id: assignmentId,
    worker_id: worker.id,
    vehicle_job_id: job.id,
    event_type: "ASSIGNED",
    occurred_at: occurredAt,
    metadata: null,
    created_at: occurredAt,
  });

  state.adminActionLogs.push({
    id: state.nextAdminActionLogId++,
    vehicle_job_id: job.id,
    gate_ticket_id: null,
    market_job_id: null,
    action_type: "MANUAL_ASSIGNMENT",
    reason_code: "MANUAL_ASSIGNMENT",
    reason_text: null,
    actor_account_id: 13201,
    metadata: {
      source: "manual_assign",
      assignment_ids: [assignmentId],
      worker_ids: [worker.id],
      worker_codes: [worker.labor_code],
    },
    created_at: occurredAt,
  });

  const response = await server.request(
    "GET",
    `/api/admin/audit/events?date_from=${today}&date_to=${today}`,
    { token }
  );

  assert.equal(response.status, 200);

  const assignedEvents = response.body.data.filter(
    (item: { event_type: string }) => item.event_type === "worker_assigned"
  );

  assert.equal(
    assignedEvents.length,
    0,
    "worker_assigned must be suppressed when the assignment was created via Manual Assign."
  );

  const manualAssignEvents = response.body.data.filter(
    (item: { event_type: string; metadata: { action?: string } }) =>
      item.event_type === "admin_override" && item.metadata.action === "manual_assign"
  );

  assert.equal(manualAssignEvents.length, 1);
  assert.deepEqual(manualAssignEvents[0].metadata.assignment_ids, [assignmentId]);
});

test("GET /api/admin/audit/events gives a TicketCompletionSubmission distinct EventIds per sub-event (submitted/confirmed), with vendor as actor when resolved_by_line_user_id is set", async () => {
  const { token } = await loginJobAdmin(13301);
  const today = bangkokDateKey();
  const submittedAt = bangkokDateToUtcIso(today, 3);
  const confirmedAt = bangkokDateToUtcIso(today, 4);
  const worker = addWorker(13302);
  const job = addDispatchableJob(133010, 1);
  job.created_at = bangkokDateToUtcIso(today, 1);
  const ticket = addTicketForTicketJob(job.id, 133011, 133012);

  const submissionId = state.nextSubmissionId++;

  state.completionSubmissions.push({
    id: submissionId,
    ticket_id: ticket.id,
    submitted_by_account_id: worker.id,
    submitted_by_role: "worker",
    status: "CONFIRMED",
    confirmed_at: confirmedAt,
    rejected_at: null,
    resolved_by_line_user_id: "line-vendor-a",
    worker_count_snapshot: 1,
    assignment_id: null,
    created_at: submittedAt,
  });

  const response = await server.request(
    "GET",
    `/api/admin/audit/events?date_from=${today}&date_to=${today}`,
    { token }
  );

  assert.equal(response.status, 200);

  const submittedEvent = response.body.data.find(
    (item: { event_id: string }) => item.event_id === `submission:${submissionId}:submitted`
  );
  const confirmedEvent = response.body.data.find(
    (item: { event_id: string }) => item.event_id === `submission:${submissionId}:confirmed`
  );

  assert.ok(submittedEvent);
  assert.equal(submittedEvent.event_type, "count_submitted");
  assert.equal(submittedEvent.actor_type, "worker");
  assert.equal(submittedEvent.actor_id, String(worker.id));

  assert.ok(confirmedEvent);
  assert.equal(confirmedEvent.event_type, "vendor_confirmed");
  assert.equal(confirmedEvent.actor_type, "vendor");
  assert.equal(confirmedEvent.actor_id, "line-vendor-a");
  assert.notEqual(submittedEvent.event_id, confirmedEvent.event_id);
});

test("GET /api/admin/audit/events marks an auto-confirmed submission (no resolved_by_line_user_id) as actor system with metadata.confirmationSource=timeout", async () => {
  const { token } = await loginJobAdmin(13401);
  const today = bangkokDateKey();
  const confirmedAt = bangkokDateToUtcIso(today, 4);
  const worker = addWorker(13402);
  const job = addDispatchableJob(134010, 1);
  job.created_at = bangkokDateToUtcIso(today, 1);
  const ticket = addTicketForTicketJob(job.id, 134011, 134012);
  const submissionId = state.nextSubmissionId++;

  state.completionSubmissions.push({
    id: submissionId,
    ticket_id: ticket.id,
    submitted_by_account_id: worker.id,
    submitted_by_role: "worker",
    status: "CONFIRMED",
    confirmed_at: confirmedAt,
    rejected_at: null,
    resolved_by_line_user_id: null,
    worker_count_snapshot: 1,
    assignment_id: null,
    created_at: confirmedAt,
  });

  const response = await server.request(
    "GET",
    `/api/admin/audit/events?date_from=${today}&date_to=${today}`,
    { token }
  );

  assert.equal(response.status, 200);

  const confirmedEvent = response.body.data.find(
    (item: { event_id: string }) => item.event_id === `submission:${submissionId}:confirmed`
  );

  assert.ok(confirmedEvent);
  assert.equal(confirmedEvent.actor_type, "system");
  assert.equal(confirmedEvent.actor_id, null);
  assert.equal(confirmedEvent.metadata.confirmationSource, "timeout");
});

test("GET /api/admin/audit/events Summary is computed from the full filtered set, not just the current page", async () => {
  const { token } = await loginJobAdmin(13501);
  const today = bangkokDateKey();
  const job = addDispatchableJob(135010, 1);
  // ตั้งนอกช่วง Query ตั้งใจ กัน TicketJob.created_at ของตัวเองสร้าง vehicle_job_created event
  // แถมมาปนกับ 3 event ที่ทดสอบเจาะจงด้านล่าง
  job.created_at = new Date(0).toISOString();

  for (let index = 0; index < 3; index += 1) {
    state.adminActionLogs.push({
      id: state.nextAdminActionLogId++,
      vehicle_job_id: job.id,
      gate_ticket_id: null,
      market_job_id: null,
      action_type: "WORKERS_RELEASED",
      reason_code: "DONE",
      reason_text: null,
      actor_account_id: 13501,
      metadata: null,
      created_at: bangkokDateToUtcIso(today, 2 + index),
    });
  }

  const page1 = await server.request(
    "GET",
    `/api/admin/audit/events?date_from=${today}&date_to=${today}&limit=1&page=1`,
    { token }
  );
  const page2 = await server.request(
    "GET",
    `/api/admin/audit/events?date_from=${today}&date_to=${today}&limit=1&page=2`,
    { token }
  );

  // actor_type_counts/event_type_counts มี key เป็นค่าจริง (เช่น "admin", "workers_released") ไม่ใช่
  // fixed field name — ผ่าน pascalCaseApiResponse ก็ถูกแปลง key ไปด้วยตามมาตรฐาน API (ตั้งใจ ไม่ต้อง
  // แก้ middleware ตาม spec ข้อ 27.1.3) จึง sum ค่าทั้งหมดแทนการ assert ตรงชื่อ key แบบเจาะจง
  const sumCounts = (counts: Record<string, number>) =>
    Object.values(counts).reduce((total, value) => total + value, 0);

  assert.equal(page1.status, 200);
  assert.equal(page1.body.data.length, 1);
  assert.equal(page1.body.pagination.total, 3);
  assert.equal(page1.body.pagination.total_pages, 3);
  assert.equal(page1.body.summary.with_reason_count, 3);
  assert.equal(sumCounts(page1.body.summary.actor_type_counts), 3);
  assert.equal(sumCounts(page1.body.summary.event_type_counts), 3);

  assert.equal(page2.body.data.length, 1);
  assert.equal(page2.body.summary.with_reason_count, 3);
  assert.notEqual(page1.body.data[0].event_id, page2.body.data[0].event_id);
});

test("GET /api/admin/audit/events actor_type and event_type filters narrow the result set, and search matches reason_text", async () => {
  const { token } = await loginJobAdmin(13601);
  const today = bangkokDateKey();
  const job = addDispatchableJob(136010, 1);
  job.created_at = bangkokDateToUtcIso(today, 1);

  state.adminActionLogs.push({
    id: state.nextAdminActionLogId++,
    vehicle_job_id: job.id,
    gate_ticket_id: null,
    market_job_id: null,
    action_type: "WORKERS_RELEASED",
    reason_code: "DONE",
    reason_text: "ปล่อยทีมกลับคิวก่อนเวลาแบบพิเศษ",
    actor_account_id: 13601,
    metadata: null,
    created_at: bangkokDateToUtcIso(today, 2),
  });

  const filteredByActor = await server.request(
    "GET",
    `/api/admin/audit/events?date_from=${today}&date_to=${today}&actor_type=worker`,
    { token }
  );
  const filteredByEventType = await server.request(
    "GET",
    `/api/admin/audit/events?date_from=${today}&date_to=${today}&event_type=workers_released`,
    { token }
  );
  const filteredBySearch = await server.request(
    "GET",
    `/api/admin/audit/events?date_from=${today}&date_to=${today}&search=${encodeURIComponent("ปล่อยทีมกลับคิวก่อนเวลาแบบพิเศษ")}`,
    { token }
  );
  const filteredBySearchMiss = await server.request(
    "GET",
    `/api/admin/audit/events?date_from=${today}&date_to=${today}&search=no-such-reason-text`,
    { token }
  );

  assert.equal(filteredByActor.status, 200);
  assert.equal(filteredByEventType.status, 200);
  assert.equal(filteredBySearch.status, 200);
  assert.equal(filteredBySearchMiss.status, 200);
  assert.equal(
    filteredByActor.body.data.filter((item: { vehicle_job_id: string }) => item.vehicle_job_id === String(job.id)).length,
    0
  );
  assert.equal(
    filteredByEventType.body.data.some((item: { event_type: string }) => item.event_type === "workers_released"),
    true
  );
  assert.equal(filteredBySearch.body.data.length >= 1, true);
  assert.equal(filteredBySearchMiss.body.data.length, 0);
});

test("GET /api/admin/audit/events rejects date_from without date_to, and a range longer than 92 days", async () => {
  const { token } = await loginJobAdmin(13701);

  const missingPair = await server.request(
    "GET",
    "/api/admin/audit/events?date_from=2026-08-01",
    { token }
  );
  const tooLong = await server.request(
    "GET",
    "/api/admin/audit/events?date_from=2026-01-01&date_to=2026-12-31",
    { token }
  );

  assert.equal(missingPair.status, 400);
  assert.equal(missingPair.body.code, "VALIDATION_ERROR");
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.code, "VALIDATION_ERROR");
});

test("GET /api/admin/audit/events projects GateRequestLog, TicketRating, and MessageDeliveryLog rows into their respective events", async () => {
  const { token } = await loginJobAdmin(13801);
  const today = bangkokDateKey();
  const occurredAt = bangkokDateToUtcIso(today, 5);
  const job = addDispatchableJob(138010, 1);
  job.created_at = bangkokDateToUtcIso(today, 1);
  const ticket = addTicketForTicketJob(job.id, 138011, 138012);
  const submissionId = state.nextSubmissionId++;

  state.completionSubmissions.push({
    id: submissionId,
    ticket_id: ticket.id,
    submitted_by_account_id: addWorker(13802).id,
    submitted_by_role: "worker",
    status: "CONFIRMED",
    confirmed_at: occurredAt,
    rejected_at: null,
    resolved_by_line_user_id: "line-vendor-a",
    worker_count_snapshot: 1,
    assignment_id: null,
    created_at: bangkokDateToUtcIso(today, 4),
  });

  state.gateRequestLogs.push({
    id: state.nextGateRequestLogId++,
    gate_transaction_ref: "GATE-138010",
    vehicle_job_id: job.id,
    market_job_id: null,
    payload_snapshot: {},
    response_snapshot: null,
    created_at: occurredAt,
  });

  state.ticketRatings.push({
    id: state.nextRatingId++,
    ticket_id: ticket.id,
    submission_id: submissionId,
    line_user_id: "line-vendor-a",
    target_type: "worker",
    score: 5,
    rated_at: occurredAt,
    created_at: occurredAt,
    updated_at: occurredAt,
  });

  state.messageDeliveryLogs.push({
    id: state.nextMessageDeliveryLogId++,
    channel: "LINE",
    job_name: "vendor_confirm_request",
    target: "line-vendor-a",
    status: "SENT",
    sent_at: occurredAt,
    created_at: occurredAt,
    updated_at: occurredAt,
  });
  state.messageDeliveryLogs.push({
    id: state.nextMessageDeliveryLogId++,
    channel: "LINE",
    job_name: "vendor_confirm_request",
    target: "line-vendor-b",
    status: "FAILED",
    sent_at: null,
    created_at: occurredAt,
    updated_at: occurredAt,
  });

  const response = await server.request(
    "GET",
    `/api/admin/audit/events?date_from=${today}&date_to=${today}`,
    { token }
  );

  assert.equal(response.status, 200);

  const eventTypes = response.body.data.map((item: { event_type: string }) => item.event_type);

  assert.ok(eventTypes.includes("gate_arrival_received"));
  assert.ok(eventTypes.includes("vendor_rated"));
  assert.ok(eventTypes.includes("message_delivery_sent"));
  assert.ok(eventTypes.includes("message_delivery_failed"));
});

test("GET /api/admin/audit/events quick_filter (has_vehicle/has_reason/critical) narrows Data and Pagination, combines with search-bar filters, rejects invalid values, and — critically — never changes Summary versus not sending quick_filter at all (27.15.1)", async () => {
  const { token } = await loginJobAdmin(14001);
  const today = bangkokDateKey();
  const job = addDispatchableJob(140010, 1);
  // ตั้งนอกช่วง Query กัน TicketJob.created_at ของตัวเองสร้าง vehicle_job_created event ปนมา
  job.created_at = new Date(0).toISOString();

  state.adminActionLogs.push({
    id: state.nextAdminActionLogId++,
    vehicle_job_id: job.id,
    gate_ticket_id: null,
    market_job_id: null,
    action_type: "WORKERS_RELEASED",
    reason_code: "DONE",
    reason_text: "ปล่อยทีมกลับคิว",
    actor_account_id: 14001,
    metadata: null,
    created_at: bangkokDateToUtcIso(today, 2),
  });

  state.adminActionLogs.push({
    id: state.nextAdminActionLogId++,
    vehicle_job_id: null,
    gate_ticket_id: null,
    market_job_id: null,
    action_type: "WORKER_STATUS_FORCED",
    reason_code: null,
    reason_text: null,
    actor_account_id: 14001,
    metadata: { worker_account_id: 14001, worker_code: "W-14001", status: "ready" },
    created_at: bangkokDateToUtcIso(today, 3),
  });

  state.adminActionLogs.push({
    id: state.nextAdminActionLogId++,
    vehicle_job_id: job.id,
    gate_ticket_id: null,
    market_job_id: null,
    action_type: "VEHICLE_JOB_CANCELLED",
    reason_code: "NO_SHOW",
    reason_text: "รถไม่มา",
    actor_account_id: 14001,
    metadata: null,
    created_at: bangkokDateToUtcIso(today, 4),
  });

  const base = `/api/admin/audit/events?date_from=${today}&date_to=${today}`;

  const noQuickFilter = await server.request("GET", base, { token });
  const hasVehicle = await server.request("GET", `${base}&quick_filter=has_vehicle`, { token });
  const hasReason = await server.request("GET", `${base}&quick_filter=has_reason`, { token });
  const critical = await server.request("GET", `${base}&quick_filter=critical`, { token });
  const criticalWithSearchBarFilter = await server.request(
    "GET",
    `${base}&event_type=vehicle_cancelled&quick_filter=has_vehicle`,
    { token }
  );
  const invalidQuickFilter = await server.request(
    "GET",
    `${base}&quick_filter=invalid`,
    { token }
  );

  assert.equal(noQuickFilter.status, 200, JSON.stringify(noQuickFilter.body));
  assert.equal(noQuickFilter.body.pagination.total, 3);

  assert.equal(hasVehicle.status, 200);
  assert.equal(hasVehicle.body.pagination.total, 2);
  assert.equal(
    hasVehicle.body.data.every(
      (item: { vehicle_job_id: string | null }) => item.vehicle_job_id !== null
    ),
    true
  );

  assert.equal(hasReason.status, 200);
  assert.equal(hasReason.body.pagination.total, 2);
  assert.equal(
    hasReason.body.data.every(
      (item: { reason_code: string | null; reason_text: string | null }) =>
        Boolean(item.reason_code || item.reason_text)
    ),
    true
  );

  assert.equal(critical.status, 200);
  assert.equal(critical.body.pagination.total, 1);
  assert.equal(critical.body.data[0].event_type, "vehicle_cancelled");

  // quick_filter ใช้ร่วมกับ filter จากแถบค้นหา (event_type) ได้ตามปกติ — ทั้งคู่แคบ Data ร่วมกันได้
  assert.equal(criticalWithSearchBarFilter.status, 200);
  assert.equal(criticalWithSearchBarFilter.body.pagination.total, 1);
  assert.equal(criticalWithSearchBarFilter.body.data[0].event_type, "vehicle_cancelled");

  assert.equal(invalidQuickFilter.status, 400);
  assert.equal(invalidQuickFilter.body.code, "VALIDATION_ERROR");

  // ข้อ 27.15.1 ข้อ 4 — สาระสำคัญที่สุด: Summary ต้องเหมือนกันทุก field ไม่ว่า quick_filter จะเป็น
  // ค่าไหน ตราบใดที่ filter จากแถบค้นหา (search/actor_type/event_type/date) เหมือนเดิม แม้ Data จะ
  // แคบลงไปตาม quick_filter ก็ตาม
  assert.deepEqual(hasVehicle.body.summary, noQuickFilter.body.summary);
  assert.deepEqual(hasReason.body.summary, noQuickFilter.body.summary);
  assert.deepEqual(critical.body.summary, noQuickFilter.body.summary);
});

test("GET /api/admin/audit/events quick_filter=system|admin narrows by resolved actor_type without touching Summary, unlike the actor_type search-bar filter which does (27.15.1 item 3)", async () => {
  const today = bangkokDateKey();

  state.securityAuditLogs.push({
    id: state.nextSecurityAuditLogId++,
    event_type: "auth_login_failed",
    outcome: "failure",
    actor_type: null,
    actor_account_id: null,
    actor_worker_id: null,
    actor_username: "unresolved-user",
    actor_full_name: null,
    session_id: null,
    request_id: null,
    ip_address: null,
    user_agent: null,
    failure_code: "unknown_username",
    metadata: null,
    created_at: bangkokDateToUtcIso(today, 1),
  });

  state.securityAuditLogs.push({
    id: state.nextSecurityAuditLogId++,
    event_type: "auth_login_succeeded",
    outcome: "success",
    actor_type: "admin",
    actor_account_id: 14201,
    actor_worker_id: null,
    actor_username: "admin-14201",
    actor_full_name: "Admin 14201",
    session_id: 5001,
    request_id: null,
    ip_address: null,
    user_agent: null,
    failure_code: null,
    metadata: null,
    created_at: bangkokDateToUtcIso(today, 2),
  });

  const { token: auditReadToken } = await loginAuditAdmin(14202);
  const base = `/api/admin/audit/events?date_from=${today}&date_to=${today}`;

  const noQuickFilter = await server.request("GET", base, { token: auditReadToken });
  const systemOnly = await server.request(
    "GET",
    `${base}&quick_filter=system`,
    { token: auditReadToken }
  );
  const adminOnly = await server.request(
    "GET",
    `${base}&quick_filter=admin`,
    { token: auditReadToken }
  );
  // เทียบกับ actor_type=admin (search-bar filter) ซึ่งต้องมีผลกับ Summary ต่างจาก quick_filter=admin
  const actorTypeAdmin = await server.request(
    "GET",
    `${base}&actor_type=admin`,
    { token: auditReadToken }
  );

  assert.equal(systemOnly.status, 200, JSON.stringify(systemOnly.body));
  assert.equal(systemOnly.body.data.length, 1);
  assert.equal(systemOnly.body.data[0].actor_type, "system");

  // adminOnly นับได้มากกว่า 1 ได้ เพราะ loginAuditAdmin() เองก็ยิง POST /api/auth/login จริง ซึ่งเขียน
  // auth_login_succeeded (actor_type=admin) ปนเข้ามาด้วย — เช็คแค่ว่าทุกแถวเป็น admin จริง และมีแถวที่
  // seed ไว้เองอยู่ในนั้น แทนการเช็ค count ตายตัว
  assert.equal(adminOnly.status, 200);
  assert.equal(
    adminOnly.body.data.every((item: { actor_type: string }) => item.actor_type === "admin"),
    true
  );
  assert.ok(
    adminOnly.body.data.some(
      (item: { metadata: { actorCode?: string } }) => item.metadata.actorCode === "admin-14201"
    )
  );

  // quick_filter=system/admin ต้องไม่แตะ Summary เลย เหมือน quick_filter อื่น
  assert.deepEqual(systemOnly.body.summary, noQuickFilter.body.summary);
  assert.deepEqual(adminOnly.body.summary, noQuickFilter.body.summary);

  // ตรงกันข้าม: actor_type=admin (filter จากแถบค้นหา) ต้องแคบ Summary ลงจริง ไม่เท่ากับ baseline
  assert.notDeepEqual(actorTypeAdmin.body.summary, noQuickFilter.body.summary);
});

test("GET /api/admin/audit/events quick_filter=has_reason and Summary.with_reason_count both use ReasonCode OR ReasonText, counting a code+text event once, not twice (27.15.2)", async () => {
  const { token } = await loginJobAdmin(14301);
  const today = bangkokDateKey();

  const codeOnly = state.nextAdminActionLogId++;
  const textOnly = state.nextAdminActionLogId++;
  const both = state.nextAdminActionLogId++;
  const neither = state.nextAdminActionLogId++;

  state.adminActionLogs.push(
    {
      id: codeOnly,
      vehicle_job_id: null,
      gate_ticket_id: null,
      market_job_id: null,
      action_type: "WORKERS_RELEASED",
      reason_code: "CODE_A",
      reason_text: null,
      actor_account_id: 14301,
      metadata: null,
      created_at: bangkokDateToUtcIso(today, 1),
    },
    {
      id: textOnly,
      vehicle_job_id: null,
      gate_ticket_id: null,
      market_job_id: null,
      action_type: "WORKERS_RELEASED",
      reason_code: null,
      reason_text: "ข้อความเหตุผล B",
      actor_account_id: 14301,
      metadata: null,
      created_at: bangkokDateToUtcIso(today, 2),
    },
    {
      id: both,
      vehicle_job_id: null,
      gate_ticket_id: null,
      market_job_id: null,
      action_type: "WORKERS_RELEASED",
      reason_code: "CODE_C",
      reason_text: "ข้อความเหตุผล C",
      actor_account_id: 14301,
      metadata: null,
      created_at: bangkokDateToUtcIso(today, 3),
    },
    {
      id: neither,
      vehicle_job_id: null,
      gate_ticket_id: null,
      market_job_id: null,
      action_type: "WORKERS_RELEASED",
      reason_code: null,
      reason_text: null,
      actor_account_id: 14301,
      metadata: null,
      created_at: bangkokDateToUtcIso(today, 4),
    },
  );

  const base = `/api/admin/audit/events?date_from=${today}&date_to=${today}`;
  const noQuickFilter = await server.request("GET", base, { token });
  const hasReason = await server.request("GET", `${base}&quick_filter=has_reason`, { token });

  assert.equal(noQuickFilter.status, 200, JSON.stringify(noQuickFilter.body));
  // Summary.with_reason_count นับ code-only + text-only + both = 3 ครั้ง (both นับครั้งเดียว ไม่ใช่ 2)
  assert.equal(noQuickFilter.body.summary.with_reason_count, 3);

  assert.equal(hasReason.status, 200);
  const hasReasonIds = hasReason.body.data.map(
    (item: { event_id: string }) => item.event_id
  );

  assert.equal(hasReason.body.pagination.total, 3);
  assert.ok(hasReasonIds.includes(`admin_action:${codeOnly}`));
  assert.ok(hasReasonIds.includes(`admin_action:${textOnly}`));
  assert.ok(hasReasonIds.includes(`admin_action:${both}`));
  assert.ok(!hasReasonIds.includes(`admin_action:${neither}`));
});

test("GET /api/admin/audit/events includes Metadata.boothName from BoothJob.boothName for vendor-facing completion submission and ticket rating events", async () => {
  const { token } = await loginJobAdmin(14101);
  const today = bangkokDateKey();
  const occurredAt = bangkokDateToUtcIso(today, 5);
  const job = addDispatchableJob(141010, 1);
  job.created_at = new Date(0).toISOString();
  const ticket = addTicketForTicketJob(job.id, 141011, 141012);
  const submissionId = state.nextSubmissionId++;

  state.completionSubmissions.push({
    id: submissionId,
    ticket_id: ticket.id,
    submitted_by_account_id: addWorker(14102).id,
    submitted_by_role: "worker",
    status: "CONFIRMED",
    confirmed_at: occurredAt,
    rejected_at: null,
    resolved_by_line_user_id: "line-vendor-a",
    worker_count_snapshot: 1,
    assignment_id: null,
    created_at: occurredAt,
  });

  state.ticketRatings.push({
    id: state.nextRatingId++,
    ticket_id: ticket.id,
    submission_id: submissionId,
    line_user_id: "line-vendor-a",
    target_type: "worker",
    score: 5,
    rated_at: occurredAt,
    created_at: occurredAt,
    updated_at: occurredAt,
  });

  const response = await server.request(
    "GET",
    `/api/admin/audit/events?date_from=${today}&date_to=${today}`,
    { token }
  );

  assert.equal(response.status, 200);

  const confirmedEvent = response.body.data.find(
    (item: { event_id: string }) => item.event_id === `submission:${submissionId}:confirmed`
  );
  const ratedEvent = response.body.data.find(
    (item: { event_type: string }) => item.event_type === "vendor_rated"
  );

  assert.ok(confirmedEvent);
  assert.equal(confirmedEvent.metadata.boothName, ticket.boothName);
  assert.ok(ratedEvent);
  assert.equal(ratedEvent.metadata.boothName, ticket.boothName);
});

test("GET /api/admin/audit/events includes Before/After on worker_force_status_changed, derived from the worker's queue status right before the force", async () => {
  const { token } = await loginJobAdmin(14201);
  const worker = addWorker(14202);
  state.connectedWorkers.add(worker.id);
  await workerQueue.recordWorkerHeartbeat(worker.id);

  const today = bangkokDateKey();

  const firstForce = await server.request(
    "POST",
    `/api/admin/jobs/workers/${worker.labor_code}/status/force`,
    { token, body: { status: "ready", reason_code: "test" } }
  );
  assert.equal(firstForce.status, 200, JSON.stringify(firstForce.body));

  const secondForce = await server.request(
    "POST",
    `/api/admin/jobs/workers/${worker.labor_code}/status/force`,
    { token, body: { status: "open_app", reason_code: "test" } }
  );
  assert.equal(secondForce.status, 200, JSON.stringify(secondForce.body));

  const logs = state.adminActionLogs.filter(
    (log) => log.action_type === "WORKER_STATUS_FORCED" && log.actor_account_id === 14201,
  );

  assert.equal(logs.length, 2);

  const response = await server.request(
    "GET",
    `/api/admin/audit/events?date_from=${today}&date_to=${today}`,
    { token }
  );

  assert.equal(response.status, 200);

  const firstEvent = response.body.data.find(
    (item: { event_id: string }) => item.event_id === `admin_action:${logs[0].id}`
  );
  const secondEvent = response.body.data.find(
    (item: { event_id: string }) => item.event_id === `admin_action:${logs[1].id}`
  );

  assert.ok(firstEvent);
  assert.equal(firstEvent.event_type, "worker_force_status_changed");
  // ก่อนหน้านี้ worker ไม่เคยเข้าคิวมาก่อน — ห้ามสร้าง Before ปลอม ส่งเฉพาะ After
  assert.equal(firstEvent.before, undefined);
  assert.deepEqual(firstEvent.after, { status: "ready" });

  assert.ok(secondEvent);
  assert.equal(secondEvent.event_type, "worker_force_status_changed");
  assert.deepEqual(secondEvent.before, { status: "ready" });
  assert.deepEqual(secondEvent.after, { status: "open_app" });
});

test("GET /api/admin/audit/events omits SecurityAuditLog events for a caller without audit:read, and maps actorCode/actor_name/attemptedUsername correctly for a caller with audit:read (27.12 phase 1)", async () => {
  const today = bangkokDateKey();

  const unknownUsernameLogId = state.nextSecurityAuditLogId++;
  state.securityAuditLogs.push({
    id: unknownUsernameLogId,
    event_type: "auth_login_failed",
    outcome: "failure",
    actor_type: null,
    actor_account_id: null,
    actor_worker_id: null,
    actor_username: "attempted-user-x",
    actor_full_name: null,
    session_id: null,
    request_id: null,
    ip_address: "203.0.113.5",
    user_agent: "TestAgent/1.0",
    failure_code: "unknown_username",
    metadata: null,
    created_at: bangkokDateToUtcIso(today, 2),
  });

  const adminLoginLogId = state.nextSecurityAuditLogId++;
  state.securityAuditLogs.push({
    id: adminLoginLogId,
    event_type: "auth_login_succeeded",
    outcome: "success",
    actor_type: "admin",
    actor_account_id: 15002,
    actor_worker_id: null,
    actor_username: "admin-15002",
    actor_full_name: "Admin 15002",
    session_id: 999,
    request_id: null,
    ip_address: "203.0.113.6",
    user_agent: "AdminWebTestAgent/1.0",
    failure_code: null,
    metadata: null,
    created_at: bangkokDateToUtcIso(today, 3),
  });

  const workerLogoutLogId = state.nextSecurityAuditLogId++;
  state.securityAuditLogs.push({
    id: workerLogoutLogId,
    event_type: "auth_logout",
    outcome: "success",
    actor_type: "worker",
    actor_account_id: null,
    actor_worker_id: 15003,
    actor_username: "W15003",
    actor_full_name: "Worker 15003",
    session_id: 888,
    request_id: null,
    ip_address: null,
    user_agent: null,
    failure_code: null,
    metadata: null,
    created_at: bangkokDateToUtcIso(today, 4),
  });

  const { token: jobsOnlyToken } = await loginJobAdmin(15001);
  const { token: auditReadToken } = await loginAuditAdmin(15004);

  const withoutAuditRead = await server.request(
    "GET",
    `/api/admin/audit/events?date_from=${today}&date_to=${today}`,
    { token: jobsOnlyToken }
  );
  const withAuditRead = await server.request(
    "GET",
    `/api/admin/audit/events?date_from=${today}&date_to=${today}`,
    { token: auditReadToken }
  );

  assert.equal(withoutAuditRead.status, 200);
  assert.equal(
    withoutAuditRead.body.data.some(
      (item: { event_id: string }) => item.event_id === `security_audit:${unknownUsernameLogId}`
    ),
    false,
    "a caller without audit:read must not see SecurityAuditLog events at all"
  );

  assert.equal(withAuditRead.status, 200);

  const unknownUsernameEvent = withAuditRead.body.data.find(
    (item: { event_id: string }) => item.event_id === `security_audit:${unknownUsernameLogId}`
  );
  const adminLoginEvent = withAuditRead.body.data.find(
    (item: { event_id: string }) => item.event_id === `security_audit:${adminLoginLogId}`
  );
  const workerLogoutEvent = withAuditRead.body.data.find(
    (item: { event_id: string }) => item.event_id === `security_audit:${workerLogoutLogId}`
  );

  assert.ok(unknownUsernameEvent);
  assert.equal(unknownUsernameEvent.actor_type, "system");
  assert.equal(unknownUsernameEvent.actor_id, null);
  assert.equal(unknownUsernameEvent.metadata.attemptedUsername, "attempted-user-x");
  assert.equal(unknownUsernameEvent.metadata.failureCode, "unknown_username");
  assert.equal(unknownUsernameEvent.metadata.outcome, "failure");
  assert.equal(unknownUsernameEvent.metadata.actorCode, undefined);

  assert.ok(adminLoginEvent);
  assert.equal(adminLoginEvent.actor_type, "admin");
  assert.equal(adminLoginEvent.actor_id, "15002");
  assert.equal(adminLoginEvent.metadata.actorCode, "admin-15002");
  // Response casing middleware แปลง "actorName" -> "ActorName" บน wire แล้วชนกับ requestKeyMap
  // เดิม (ActorName: "actor_name") ที่ออกแบบไว้สำหรับ actor_name field อื่นอยู่แล้ว (เช่น Work
  // History Timeline) ทำให้ server.request() ฝั่ง test แปลงกลับเป็น "actor_name" ไม่ใช่ "actorName" —
  // พฤติกรรมนี้ตั้งใจและสอดคล้องกับ field actor_name อื่นทั้งระบบ ไม่ใช่ bug
  assert.equal(adminLoginEvent.metadata.actor_name, "Admin 15002");
  assert.equal(adminLoginEvent.metadata.sessionId, 999);

  assert.ok(workerLogoutEvent);
  assert.equal(workerLogoutEvent.actor_type, "worker");
  assert.equal(workerLogoutEvent.actor_id, "15003");
  assert.equal(workerLogoutEvent.worker_id, "15003");
  // Worker actor ใช้ metadata key เดียวกับ Admin actor (actorCode/actor_name) แทน workerCode เดิม
  // เพื่อให้ Frontend เช็ค key เดียวกันได้ไม่ว่า actor_type จะเป็น admin หรือ worker
  assert.equal(workerLogoutEvent.metadata.actorCode, "W15003");
  assert.equal(workerLogoutEvent.metadata.actor_name, "Worker 15003");
});

test("GET /api/admin/audit/events paginates SecurityAuditLog events correctly (total/total_pages/page overflow) merged in with the same code path as the other 8 sources, and excludes them entirely from pagination for a caller without audit:read (27.12 item 9 — merged pagination)", async () => {
  const today = bangkokDateKey();
  const workerId = 15101;

  for (let hour = 1; hour <= 5; hour += 1) {
    state.securityAuditLogs.push({
      id: state.nextSecurityAuditLogId++,
      event_type: "auth_logout",
      outcome: "success",
      actor_type: "worker",
      actor_account_id: null,
      actor_worker_id: workerId,
      actor_username: "W15101",
      actor_full_name: "Worker 15101",
      session_id: 1000 + hour,
      request_id: null,
      ip_address: null,
      user_agent: null,
      failure_code: null,
      metadata: null,
      created_at: bangkokDateToUtcIso(today, hour),
    });
  }

  const { token: auditReadToken } = await loginAuditAdmin(15102);
  const { token: jobsOnlyToken } = await loginJobAdmin(15103);

  const page1 = await server.request(
    "GET",
    `/api/admin/audit/events?date_from=${today}&date_to=${today}&event_type=auth_logout&limit=2&page=1`,
    { token: auditReadToken }
  );
  const page2 = await server.request(
    "GET",
    `/api/admin/audit/events?date_from=${today}&date_to=${today}&event_type=auth_logout&limit=2&page=2`,
    { token: auditReadToken }
  );
  const page3 = await server.request(
    "GET",
    `/api/admin/audit/events?date_from=${today}&date_to=${today}&event_type=auth_logout&limit=2&page=3`,
    { token: auditReadToken }
  );
  const withoutAuditRead = await server.request(
    "GET",
    `/api/admin/audit/events?date_from=${today}&date_to=${today}&event_type=auth_logout&limit=2&page=1`,
    { token: jobsOnlyToken }
  );

  assert.equal(page1.status, 200);
  assert.equal(page1.body.pagination.total, 5);
  assert.equal(page1.body.pagination.total_pages, 3);
  assert.equal(page1.body.data.length, 2);
  // Sort ล่าสุดก่อนเสมอ (DESC by occurred_at) เหมือน source อื่นทุกตัว
  assert.equal(page1.body.data[0].metadata.sessionId, 1005);
  assert.equal(page1.body.data[1].metadata.sessionId, 1004);

  assert.equal(page2.status, 200);
  assert.equal(page2.body.data.length, 2);
  assert.equal(page2.body.data[0].metadata.sessionId, 1003);
  assert.equal(page2.body.data[1].metadata.sessionId, 1002);

  assert.equal(page3.status, 200);
  assert.equal(page3.body.data.length, 1);
  assert.equal(page3.body.data[0].metadata.sessionId, 1001);

  assert.equal(withoutAuditRead.status, 200);
  assert.equal(withoutAuditRead.body.pagination.total, 0);
  assert.deepEqual(withoutAuditRead.body.data, []);
});

test("GET /api/admin/audit/events SecurityAuditLog response-shape contract covers all 4 presence patterns generically — Metadata-only, After-only (create), Before+After (update), and Before/After alongside extra Metadata — since the mapper (mapSecurityAuditLogEvents) is event-type-agnostic and applies the same extraction rules to every stable event code (27.14.3 items 3-4)", async () => {
  const today = bangkokDateKey();

  // 1) Metadata-only — no before/after at all (e.g. auth_login_failed)
  const metadataOnlyId = state.nextSecurityAuditLogId++;
  state.securityAuditLogs.push({
    id: metadataOnlyId,
    event_type: "auth_login_failed",
    outcome: "failure",
    actor_type: null,
    actor_account_id: null,
    actor_worker_id: null,
    actor_username: "someone",
    actor_full_name: null,
    session_id: null,
    request_id: "req-metadata-only",
    ip_address: "203.0.113.9",
    user_agent: "TestAgent/2.0",
    failure_code: "invalid_password",
    metadata: null,
    created_at: bangkokDateToUtcIso(today, 5),
  });

  // 2) After-only — a *_created event, nothing existed before it
  const afterOnlyId = state.nextSecurityAuditLogId++;
  state.securityAuditLogs.push({
    id: afterOnlyId,
    event_type: "mobile_app_version_created",
    outcome: "success",
    actor_type: "admin",
    actor_account_id: 15301,
    actor_worker_id: null,
    actor_username: "admin-15301",
    actor_full_name: "Admin 15301",
    session_id: null,
    request_id: "req-after-only",
    ip_address: null,
    user_agent: null,
    failure_code: null,
    metadata: {
      targetType: "mobile_app_version",
      targetVersionId: 999,
      after: { version: "9.9.9", build_number: 99900 },
    },
    created_at: bangkokDateToUtcIso(today, 6),
  });

  // 3) Before+After — a *_updated event with only targetType alongside
  const beforeAfterId = state.nextSecurityAuditLogId++;
  state.securityAuditLogs.push({
    id: beforeAfterId,
    event_type: "system_settings_updated",
    outcome: "success",
    actor_type: "admin",
    actor_account_id: 15302,
    actor_worker_id: null,
    actor_username: "admin-15302",
    actor_full_name: "Admin 15302",
    session_id: null,
    request_id: "req-before-after",
    ip_address: null,
    user_agent: null,
    failure_code: null,
    metadata: {
      targetType: "system_settings",
      before: { worker_break_limit: 3 },
      after: { worker_break_limit: 5 },
    },
    created_at: bangkokDateToUtcIso(today, 7),
  });

  // 4) Before/After alongside richer extra Metadata beyond targetType (e.g. admin_permissions_changed)
  const beforeAfterWithMetadataId = state.nextSecurityAuditLogId++;
  state.securityAuditLogs.push({
    id: beforeAfterWithMetadataId,
    event_type: "admin_permissions_changed",
    outcome: "success",
    actor_type: "admin",
    actor_account_id: 15303,
    actor_worker_id: null,
    actor_username: "admin-15303",
    actor_full_name: "Admin 15303",
    session_id: null,
    request_id: "req-before-after-meta",
    ip_address: null,
    user_agent: null,
    failure_code: null,
    metadata: {
      targetType: "admin_account",
      targetAccountId: 20001,
      targetUsername: "target-admin",
      before: { permission_level: "supervisor", permissions: ["workers:read"] },
      after: { permission_level: "manager", permissions: ["workers:read", "workers:update"] },
    },
    created_at: bangkokDateToUtcIso(today, 8),
  });

  const { token } = await loginAuditAdmin(15304);
  const response = await server.request(
    "GET",
    `/api/admin/audit/events?date_from=${today}&date_to=${today}`,
    { token }
  );

  assert.equal(response.status, 200, JSON.stringify(response.body));

  const byId = (id: number) =>
    response.body.data.find(
      (item: { event_id: string }) => item.event_id === `security_audit:${id}`
    );

  const metadataOnly = byId(metadataOnlyId);
  assert.ok(metadataOnly);
  assert.equal(metadataOnly.metadata.outcome, "failure");
  assert.equal(metadataOnly.metadata.requestId, "req-metadata-only");
  assert.equal("before" in metadataOnly, false);
  assert.equal("after" in metadataOnly, false);

  const afterOnly = byId(afterOnlyId);
  assert.ok(afterOnly);
  assert.equal("before" in afterOnly, false);
  assert.deepEqual(afterOnly.after, { version: "9.9.9", build_number: 99900 });
  assert.equal(afterOnly.metadata.targetVersionId, 999);
  // ต้องไม่ซ้ำอยู่ใน metadata ด้วย — before/after ต้อง extract ออกมาเป็น top-level เท่านั้น
  assert.equal("before" in afterOnly.metadata, false);
  assert.equal("after" in afterOnly.metadata, false);

  const beforeAfter = byId(beforeAfterId);
  assert.ok(beforeAfter);
  assert.deepEqual(beforeAfter.before, { worker_break_limit: 3 });
  assert.deepEqual(beforeAfter.after, { worker_break_limit: 5 });

  const beforeAfterWithMetadata = byId(beforeAfterWithMetadataId);
  assert.ok(beforeAfterWithMetadata);
  assert.deepEqual(beforeAfterWithMetadata.before, {
    permission_level: "supervisor",
    permissions: ["workers:read"],
  });
  assert.deepEqual(beforeAfterWithMetadata.after, {
    permission_level: "manager",
    permissions: ["workers:read", "workers:update"],
  });
  assert.equal(beforeAfterWithMetadata.metadata.targetAccountId, 20001);
  assert.equal(beforeAfterWithMetadata.metadata.targetUsername, "target-admin");
  assert.equal("before" in beforeAfterWithMetadata.metadata, false);
  assert.equal("after" in beforeAfterWithMetadata.metadata, false);

  // Redaction contract: ต้องไม่มี token/password/secret หลุดมาใน response ของทั้ง 4 แบบ — เช็คเฉพาะ
  // field name ที่บ่งบอก credential จริง ไม่ใช่ blanket substring เพราะ "invalid_password" เป็น
  // failureCode ที่ตั้งใจให้แสดงอยู่แล้ว (ไม่ใช่ค่า password จริง) และจะ false-positive ถ้าเช็คแบบ
  // substring เดา ๆ
  const forbiddenValueSubstrings = [
    "password_hash",
    "passwordhash",
    "access_token",
    "accesstoken",
    "refresh_token",
    "refreshtoken",
    "secret_hash",
    "secrethash",
    "client_secret",
    "clientsecret",
  ];

  for (const item of [metadataOnly, afterOnly, beforeAfter, beforeAfterWithMetadata]) {
    const serialized = JSON.stringify(item).toLowerCase();

    for (const forbidden of forbiddenValueSubstrings) {
      assert.equal(serialized.includes(forbidden), false, `must not leak ${forbidden}`);
    }
  }
});

test("GET /api/admin/audit/events excludes SecurityAuditLog events from Summary counts entirely for a caller without audit:read (27.14.3 item 5)", async () => {
  const today = bangkokDateKey();

  for (let i = 0; i < 3; i += 1) {
    state.securityAuditLogs.push({
      id: state.nextSecurityAuditLogId++,
      event_type: "auth_logout",
      outcome: "success",
      actor_type: "worker",
      actor_account_id: null,
      actor_worker_id: 15201,
      actor_username: "W15201",
      actor_full_name: "Worker 15201",
      session_id: 2000 + i,
      request_id: null,
      ip_address: null,
      user_agent: null,
      failure_code: null,
      metadata: null,
      created_at: bangkokDateToUtcIso(today, i + 1),
    });
  }

  const { token: auditReadToken } = await loginAuditAdmin(15202);
  const { token: jobsOnlyToken } = await loginJobAdmin(15203);

  const withAuditRead = await server.request(
    "GET",
    `/api/admin/audit/events?date_from=${today}&date_to=${today}&event_type=auth_logout`,
    { token: auditReadToken }
  );
  const withoutAuditRead = await server.request(
    "GET",
    `/api/admin/audit/events?date_from=${today}&date_to=${today}&event_type=auth_logout`,
    { token: jobsOnlyToken }
  );

  assert.equal(withAuditRead.status, 200, JSON.stringify(withAuditRead.body));
  assert.equal(withAuditRead.body.summary.actor_type_counts.worker, 3);
  // Dynamic key จาก event_type ดิบ ("auth_logout") ผ่าน response case-conversion กลายเป็น
  // camelCase บน wire ("authLogout") — ต่างจาก field name คงที่ (เช่น EventTypeCounts) ที่มี
  // requestKeyMap แปลงกลับให้เป็น snake_case เพราะ dynamic key ไม่ได้อยู่ใน map นั้น
  assert.equal(withAuditRead.body.summary.event_type_counts.authLogout, 3);

  assert.equal(withoutAuditRead.status, 200, JSON.stringify(withoutAuditRead.body));
  // ต้องไม่นับปนใน Summary เลย ไม่ใช่แค่ Data/Pagination — ทั้ง 3 field ต้องไม่เห็น auth_logout/worker
  // ที่มาจาก SecurityAuditLog เลย
  assert.equal(withoutAuditRead.body.summary.actor_type_counts.worker, undefined);
  assert.equal(withoutAuditRead.body.summary.event_type_counts.authLogout, undefined);
});

test("GET /api/admin/audit/events requires admin jobs:read permission", async () => {
  const unauthenticated = await server.request("GET", "/api/admin/audit/events");

  assert.equal(unauthenticated.status, 401);

  const workerLogin = await loginWorker(13901);
  const workerResponse = await server.request("GET", "/api/admin/audit/events", {
    token: workerLogin.token,
  });

  assert.equal(workerResponse.status, 403);
});
