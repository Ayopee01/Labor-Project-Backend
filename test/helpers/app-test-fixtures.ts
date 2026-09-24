import { Prisma } from "@prisma/client";
import { FakeRedis } from "./app-test-infra-mocks";
import { state } from "./app-test-state";
import type { AccountRecord, AssignmentRecord, GateClientRecord, MasterWorkerRecord, MobileAppVersionRecord, BoothJobRecord, MarketJobRecord, TicketJobRecord } from "./app-test-harness.records";

/* -------------------------------------- Test Data Builders -------------------------------------- */

function seedMasterDataForRouteTests(): void {
  state.masterMarkets.push(
    ...[
      "000",
      "000B",
      "001",
      "002",
      "003",
      "004",
      "005",
      "006",
      "007",
      "008",
      "009",
      "010",
      "011",
      "012",
      "013",
    ].map((suffix, index) => ({
      id: index + 1,
      marketCode: `MARKET-${suffix}`,
      marketName: "Market A",
      boothCode: `STALL-${suffix}`,
      boothName: "Vendor A",
      marketStatus: "Normal",
      boothStatus: "Normal",
    })),
    {
      id: 1001,
      marketCode: "MARKET-004",
      marketName: "Market A",
      boothCode: "STALL-004-B",
      boothName: "Vendor B",
      marketStatus: "Normal",
      boothStatus: "Normal",
    },
    {
      id: 1002,
      marketCode: "MARKET-008",
      marketName: "Market A",
      boothCode: "STALL-008-B",
      boothName: "Vendor B",
      marketStatus: "Normal",
      boothStatus: "Normal",
    },
    {
      id: 1004,
      marketCode: "MARKET-009",
      marketName: "Market A",
      boothCode: "STALL-008-B",
      boothName: "Vendor B",
      marketStatus: "Normal",
      boothStatus: "Normal",
    },
    {
      id: 1003,
      marketCode: "MARKET-012",
      marketName: "Market A",
      boothCode: "STALL-012-B",
      boothName: "Vendor B",
      marketStatus: "Normal",
      boothStatus: "Normal",
    },
    {
      id: 1005,
      marketCode: "MARKET-011",
      marketName: "Market A",
      boothCode: "STALL-010",
      boothName: "Vendor A",
      marketStatus: "Normal",
      boothStatus: "Normal",
    },
    {
      id: 1006,
      marketCode: "MARKET-013",
      marketName: "Market A",
      boothCode: "STALL-012-B",
      boothName: "Vendor B",
      marketStatus: "Normal",
      boothStatus: "Normal",
    },
  );
  state.masterProducts.push(
    {
      id: 1,
      productCode: "02020300",
      productFullCode: "02020300000000000000",
      productName: "Rambutan",
      packageCode: "29",
      packageName: "Crate 20",
      packageWeight: 20,
      range: {
        workerRanges: {
          range1To50: 1,
          range51To100: 2,
          range101To200: 3,
          range201To400: 4,
          range401To600: 4,
          rangeOver600: 5,
        },
      },
      status: "ACTIVE",
    },
    {
      id: 2,
      productCode: "02030103",
      productFullCode: "02030103000000000000",
      productName: "Cherry",
      packageCode: "19",
      packageName: "Box 10",
      packageWeight: 20,
      range: {
        workerRanges: {
          range1To50: 1,
          range51To100: 2,
          range101To200: 3,
          range201To400: 4,
          range401To600: 4,
          rangeOver600: 5,
        },
      },
      status: "ACTIVE",
    },
    {
      id: 3,
      productCode: "02011701",
      productFullCode: "02011701000000000000",
      productName: "Melon",
      packageCode: "19",
      packageName: "Box 10",
      packageWeight: 20,
      range: {
        workerRanges: {
          range1To50: 1,
          range51To100: 2,
          range101To200: 3,
          range201To400: 4,
          range401To600: 4,
          rangeOver600: 5,
        },
      },
      status: "ACTIVE",
    },
  );
  state.masterRates.push(
    {
      id: 1,
      sourceRateId: 1,
      marketCode: "0000",
      weightRangeName: "1-25.0",
      weightMin: new Prisma.Decimal("0.00"),
      weightMax: new Prisma.Decimal("25.00"),
      stallRate: new Prisma.Decimal("1.50"),
      laborRate: new Prisma.Decimal("0.90"),
      status: 1,
    },
    {
      id: 2,
      sourceRateId: 2,
      marketCode: "0000",
      weightRangeName: "25.1-50.0",
      weightMin: new Prisma.Decimal("25.00"),
      weightMax: new Prisma.Decimal("50.00"),
      stallRate: new Prisma.Decimal("3.50"),
      laborRate: new Prisma.Decimal("2.59"),
      status: 1,
    },
  );
}

/* -------------------------------------- Test Data Builders -------------------------------------- */

// Function สร้าง schedule ของวันนี้สำหรับ test data
function todaySchedule(workerId: number) {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return {
    id: workerId,
    worker_id: workerId,
    time_work: "Morning",
    work_date: `${year}-${month}-${day}`,
    time_in: "00:00",
    time_out: "23:59",
    is_current: true,
    created_by: null,
    updated_by: null,
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
  };
}

export function recordWorkerAssignmentEventOnce(
  assignment: AssignmentRecord,
  eventType: string,
  metadata: Record<string, unknown> | null = null,
  occurredAt = new Date().toISOString(),
): void {
  const existing = state.workerAssignmentEvents.find(
    (event) =>
      event.assignment_id === assignment.id && event.event_type === eventType,
  );

  if (existing) {
    return;
  }

  state.workerAssignmentEvents.push({
    id: state.nextWorkerAssignmentEventId++,
    assignment_id: assignment.id,
    worker_id: assignment.worker_id,
    vehicle_job_id: assignment.vehicle_job_id,
    event_type: eventType,
    occurred_at: occurredAt,
    metadata,
    created_at: new Date().toISOString(),
  });
}

// Function รีเซ็ต route test state สำหรับ test
export function resetRouteTestState(): void {
  FakeRedis.hashes.clear();
  FakeRedis.zsets.clear();
  FakeRedis.strings.clear();
  state.connectedWorkers.clear();
  state.socketEvents.length = 0;
  state.notifications.length = 0;
  state.realtimeEvents.length = 0;
  state.lineMessages.length = 0;
  state.workerPushTokens.length = 0;
  state.workerNotifications.length = 0;
  state.workers.clear();
  state.workersByLaborCode.clear();
  state.workerSessions.clear();
  state.schedules.clear();
  state.ticketJobs.length = 0;
  state.marketJobs.length = 0;
  state.assignments.length = 0;
  state.workerAssignmentEvents.length = 0;
  state.boothJobs.length = 0;
  state.ticketProducts.length = 0;
  state.ticketWorkers.length = 0;
  state.ticketProductFinancials.length = 0;
  state.ticketWorkerPayments.length = 0;
  state.boothJobWorkerSnapshots.length = 0;
  state.submissionWorkerSnapshots.length = 0;
  state.completionSubmissions.length = 0;
  state.ticketRatings.length = 0;
  state.lineActionTokens.length = 0;
  state.gateRequestLogs.length = 0;
  state.driverSessions.length = 0;
  state.messageDeliveryLogs.length = 0;
  state.adminActionLogs.length = 0;
  state.securityAuditLogs.length = 0;
  state.forceSecurityAuditLogWriteFailure = false;
  state.masterMarkets.length = 0;
  state.masterProducts.length = 0;
  state.masterRates.length = 0;
  state.masterOwnerStalls.length = 0;
  state.masterMemberStalls.length = 0;
  state.gateClients.clear();
  state.mobileAppVersions.length = 0;
  state.checkinLogs.length = 0;
  state.breakLogs.length = 0;
  state.authAccountsByUsername.clear();
  state.authAccountsById.clear();
  state.adminPermissions.clear();
  state.profiles.clear();
  state.authSchedules.clear();
  state.sessions.clear();
  state.queueJobs.clear();
  state.queueJobs.set(
    process.env.BULLMQ_ASSIGNMENT_TIMEOUT_QUEUE as string,
    new Map(),
  );
  state.queueJobs.set(
    process.env.BULLMQ_WORKER_BREAK_RETURN_QUEUE as string,
    new Map(),
  );
  state.nextMarketJobId = 1;
  state.nextAssignmentId = 1;
  state.nextWorkerAssignmentEventId = 1;
  state.nextWorkerNotificationId = 1;
  state.nextSessionId = 1;
  state.nextWorkerSessionId = 1;
  state.nextTicketWorkerId = 1;
  state.nextTicketProductFinancialId = 1;
  state.nextTicketWorkerPaymentId = 1;
  state.nextBoothJobWorkerSnapshotId = 1;
  state.nextSubmissionWorkerSnapshotId = 1;
  state.nextSubmissionId = 1;
  state.nextRatingId = 1;
  state.nextLineActionTokenId = 1;
  state.nextGateClientId = 1;
  state.nextCheckinLogId = 1;
  state.nextBreakLogId = 1;
  state.nextMobileAppVersionId = 1;
  state.nextGateRequestLogId = 1;
  state.nextDriverSessionId = 1;
  state.nextMessageDeliveryLogId = 1;
  seedMasterDataForRouteTests();
}

// Function จัดการ add worker สำหรับ test — Worker เป็น MasterWorkerRecord ล้วนๆ ไม่มี Account
// record อีกต่อไป (ดู MasterWorker refactor) worker.md เก็บ password = telephone แต่ test fixture
// ยังรับ passwordHash ตรงๆ เพื่อให้ test เดิมที่ควบคุม hash เองยังทำงานได้
export function addWorker(
  workerId: number,
  passwordHash = "hash",
): MasterWorkerRecord {
  const laborCode = `W${workerId}`;
  const now = new Date().toISOString();
  const worker: MasterWorkerRecord = {
    id: workerId,
    labor_code: laborCode,
    password_hash: passwordHash,
    status: 1,
    full_name: `Worker ${workerId}`,
    telephone: `081-${String(workerId).padStart(7, "0")}`,
    nationality: "Thai",
    labor_color: "standard",
    coat_no: String(workerId),
    image_url: null,
    work_start_date: "2026-01-01",
    time_work: "Morning",
    time_in: "00:00",
    time_out: "23:59",
    lang: "TH",
    source: "admin_created",
    created_at: now,
    updated_at: now,
  };

  state.workers.set(workerId, worker);
  state.workersByLaborCode.set(laborCode, worker);
  state.schedules.set(workerId, todaySchedule(workerId));

  // Shadow record เก็บไว้ใน authAccountsById (ตาม id เท่านั้น ไม่ใส่ authAccountsByUsername) เพื่อให้
  // ส่วนที่ยังไม่ได้ migrate ไป MasterWorker เต็มรูปแบบ (admin-jobs/admin-audit mock — รอ Phase 3)
  // ที่ resolve "worker info by id" จาก Account เดิม ยังทำงานได้ตามปกติ — ต้องไม่ใส่ใน
  // authAccountsByUsername เพราะ auth.service.ts login ใหม่ใช้ accountRepository.findByUsername
  // เพื่อแยกว่า username นี้เป็น Admin หรือไม่ ถ้า worker หลุดเข้ามาในนั้นจะถูกเข้าใจผิดว่าเป็น Admin
  state.authAccountsById.set(workerId, {
    id: workerId,
    username: laborCode,
    password_hash: passwordHash,
    role: "worker",
    status: "active",
    full_name: worker.full_name ?? `Worker ${workerId}`,
    position: null,
    email: null,
    phone: worker.telephone ?? null,
    image_url: worker.picture ?? null,
    shirt_number: worker.coat_no ?? null,
    time_work: worker.time_work ?? null,
    permission_level: null,
    lang: worker.lang,
    created_at: now,
    updated_at: now,
  });

  return worker;
}

// Function จัดการ add admin สำหรับ test
export function addAdmin(
  accountId: number,
  passwordHash = "hash",
): AccountRecord {
  const admin: AccountRecord = {
    id: accountId,
    username: `admin-${accountId}`,
    password_hash: passwordHash,
    role: "admin",
    status: "active",
    full_name: `Admin ${accountId}`,
    position: "Administrator",
    email: `admin-${accountId}@simmummuang.local`,
    phone: `081-000-${String(accountId).padStart(4, "0")}`,
    permission_level: "manager",
    lang: "TH",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  state.authAccountsByUsername.set(admin.username, admin);
  state.authAccountsById.set(admin.id, admin);
  state.adminPermissions.set(admin.id, [
    "admins:create",
    "gate_clients:read",
    "gate_clients:create",
    "gate_clients:update",
    "gate_clients:rotate_secret",
    "permissions:read",
    "permissions:update",
    "roles:read",
    "workers:read",
  ]);

  return admin;
}

// Function จัดการ add Gate client สำหรับ test
export function addGateClient(
  clientId: string,
  secretHash = "hash",
  status: "active" | "inactive" = "active",
): GateClientRecord {
  const now = new Date().toISOString();
  const gateClient: GateClientRecord = {
    id: state.nextGateClientId++,
    client_id: clientId,
    name: `Gate ${clientId}`,
    secret_hash: secretHash,
    status,
    last_used_at: null,
    created_by: null,
    updated_by: null,
    created_at: now,
    updated_at: now,
  };

  state.gateClients.set(gateClient.client_id, gateClient);

  return gateClient;
}

// Function จัดการ add Mobile App Version สำหรับ test
export function addMobileAppVersion(
  overrides: Partial<MobileAppVersionRecord> & {
    version: string;
    build_number: number;
  },
): MobileAppVersionRecord {
  const now = new Date().toISOString();
  const record: MobileAppVersionRecord = {
    id: state.nextMobileAppVersionId++,
    release_at: null,
    android_download_url: "https://play.google.com/store/apps/details?id=test",
    ios_download_url: "https://apps.apple.com/app/id0000000000",
    force_update_at: null,
    release_notification_at: null,
    release_notification_sent_at: null,
    force_update_notification_sent_at: null,
    release_message: null,
    release_notes: null,
    created_by: null,
    updated_by: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };

  state.mobileAppVersions.push(record);

  return record;
}

// Function จัดการ add dispatchable job สำหรับ test
//
// ticketsClosedAt ถูกตั้งค่าปิดรับ Ticket เพิ่มทันที (จำลองว่า Gate ส่ง Ticket เดียวจบ) เพื่อให้
// Test เดิมที่คาดหวังว่า TicketNumber จบอัตโนมัติเมื่อ Ticket เดียวจบยังทำงานได้ตามเดิม
// Test ที่ต้องการทดสอบ TicketNumber ที่ยังเปิดรับ Ticket เพิ่มต้อง set state.ticketJobs
// ตัวนั้น .tickets_closed_at = null เอง หรือใช้ addDispatchableJob แล้วปรับ field ทีหลัง
export function addDispatchableJob(
  id: number,
  workersRequired: number,
): TicketJobRecord {
  const now = new Date().toISOString();
  const job: TicketJobRecord = {
    id,
    ticket_number: `JOB-${id}`,
    license_plate: `TEST-${id}`,
    license_plate_province: "Bangkok",
    vehicle_type: "truck",
    workers_required: workersRequired,
    dispatch_now: true,
    status: "WORKING",
    driver_qr_token: `driver-qr-${id}`,
    expected_ticket_count: null,
    tickets_closed_at: now,
    created_at: now,
    updated_at: now,
  };

  state.ticketJobs.push(job);

  return job;
}

// Function จัดการ add Business Ticket (market job) สำหรับ vehicle job สำหรับ test
export function addMarketJobForVehicle(
  ticketJobId: number,
  overrides: Partial<MarketJobRecord> = {},
): MarketJobRecord {
  const now = new Date().toISOString();
  const id = overrides.id ?? state.nextMarketJobId++;

  if (id >= state.nextMarketJobId) {
    state.nextMarketJobId = id + 1;
  }

  const marketJob: MarketJobRecord = {
    id,
    vehicle_job_id: ticketJobId,
    ticket_no: overrides.ticket_no ?? `TICKET-${ticketJobId}-${id}`,
    ticket_created_at: overrides.ticket_created_at ?? now,
    booth_count: overrides.booth_count ?? 1,
    gate_transaction_ref:
      overrides.gate_transaction_ref ?? `GATE-${ticketJobId}-${id}`,
    workers_required: overrides.workers_required ?? 1,
    marketCode: overrides.marketCode ?? `MARKET-${ticketJobId}`,
    marketName: overrides.marketName ?? "Market A",
    dropoff_point:
      overrides.dropoff_point === undefined ? "Dock A1" : overrides.dropoff_point,
    status: overrides.status ?? "WORKING",
    worker_roster_locked_at: overrides.worker_roster_locked_at ?? null,
    final_stall_amount: overrides.final_stall_amount ?? null,
    financialized_at: overrides.financialized_at ?? null,
    completed_at: overrides.completed_at ?? null,
    created_at: now,
    updated_at: now,
  };

  state.marketJobs.push(marketJob);

  return marketJob;
}

// Function จัดการ add pending assignment สำหรับ test
export function addPendingAssignment(
  id: number,
  ticketJobId: number,
  workerId: number,
  deadlineMs = 60_000,
): AssignmentRecord {
  const now = new Date().toISOString();
  const assignment = {
    id,
    vehicle_job_id: ticketJobId,
    worker_id: workerId,
    status: "PENDING",
    accept_deadline_at: new Date(Date.now() + deadlineMs).toISOString(),
    scan_deadline_at: null,
    accepted_at: null,
    scanned_at: null,
    completed_at: null,
    created_at: now,
    updated_at: now,
  };

  state.assignments.push(assignment);

  return assignment;
}

// Function จัดการ add booth (BoothJob) ให้ Business Ticket ของ vehicle job สำหรับ test
//
// ถ้าไม่ระบุ marketJobId จะ reuse/สร้าง Business Ticket เดียวที่ id = ticketJobId + 2000
// (พฤติกรรมเดิมก่อน Refactor: หนึ่ง vehicle job = หนึ่ง Business Ticket) เพื่อให้ Test เดิมที่
// เรียกฟังก์ชันนี้หลายครั้งกับ ticketJobId เดิมยัง append booth เข้า Business Ticket ใบเดียวกัน
// Test ที่ต้องการหลาย Business Ticket ต่อหนึ่ง vehicle job ให้ส่ง marketJobId ที่ต่างกันมาเอง
// (สร้างผ่าน addMarketJobForVehicle ก่อน)
export function addTicketForTicketJob(
  ticketJobId: number,
  ticketId = ticketJobId + 1000,
  marketJobId = ticketJobId + 2000,
): BoothJobRecord {
  const now = new Date().toISOString();
  // ticket_no ต้อง unique ภายใน ticketJobId เดียวกันเสมอ (ตรงกับ @@unique([ticketJobId,
  // ticketNo]) จริงใน DB) จึงต้องผูกกับ marketJobId ด้วย ไม่ใช่แค่ ticketJobId เฉยๆ มิฉะนั้น
  // Test ที่สร้างหลาย Business Ticket ต่อรถคันเดียวกัน (ส่ง marketJobId ต่างกันมาเอง) จะได้
  // ticket_no ซ้ำกันโดยไม่ตั้งใจ
  const marketJob =
    state.marketJobs.find((candidate) => candidate.id === marketJobId) ??
    addMarketJobForVehicle(ticketJobId, {
      id: marketJobId,
      ticket_no: `TICKET-${ticketJobId}-${marketJobId}`,
    });
  const ticket = {
    id: ticketId,
    vehicle_job_id: ticketJobId,
    market_job_id: marketJob.id,
    marketCode: marketJob.marketCode,
    marketName: marketJob.marketName,
    dropoff_point: marketJob.dropoff_point,
    boothCode: `STALL-${ticketId}`,
    boothName: "Vendor A",
    vendor_line_id: "line-vendor-a",
    reject_reason: null,
    status: "WORKING",
    confirmation_status: null,
    completed_at: null,
    financialized_at: null,
    created_at: now,
    updated_at: now,
  };

  state.boothJobs.push(ticket);
  state.ticketProducts.push(
    {
      id: ticketId * 10 + 1,
      ticket_id: ticketId,
      productCode: `PRODUCT-${ticketId}-1`,
      productFullCode: null,
      productName: "Apple",
      packageCode: "fruit",
      packageName: "kg",
      quantity: "10",
      confirmed_quantity: null,

      package_weight_snapshot: "20",
      rate_id_snapshot: 1,
      source_rate_id_snapshot: 1,
      rate_market_code: "0000",
      rate_source: "CENTRAL_RATE",
      weight_range_name: "1-25.0",
      weight_min_snapshot: "0.00",
      weight_max_snapshot: "25.00",
      stall_rate_snapshot: "1.50",
      labor_rate_snapshot: "0.90",
      rate_snapshot_at: now,
      created_at: now,
      updated_at: now,
    },
    {
      id: ticketId * 10 + 2,
      ticket_id: ticketId,

      productCode: `PRODUCT-${ticketId}-2`,
      productFullCode: null,
      productName: "Cabbage",

      packageCode: "vegetable",
      packageName: "box",

      quantity: "5",
      confirmed_quantity: null,

      package_weight_snapshot: "20",
      rate_id_snapshot: 1,
      source_rate_id_snapshot: 1,
      rate_market_code: "0000",
      rate_source: "CENTRAL_RATE",
      weight_range_name: "1-25.0",
      weight_min_snapshot: "0.00",
      weight_max_snapshot: "25.00",
      stall_rate_snapshot: "1.50",
      labor_rate_snapshot: "0.90",
      rate_snapshot_at: now,
      created_at: now,
      updated_at: now,
    },
  );

  return ticket;
}

// Function ค้นหา current open ticket สำหรับ vehicle job สำหรับ test
export function findCurrentOpenTicketForTicketJob(ticketJobId: number): {
  ticket: BoothJobRecord;
  marketCode: string;
  marketName: string;
  dropoff_point: string | null;
} | null {
  const ticket = state.boothJobs
    .filter(
      (candidate) =>
        candidate.vehicle_job_id === ticketJobId &&
        !["COMPLETED", "CANCELLED"].includes(candidate.status),
    )
    .sort((a, b) => a.market_job_id - b.market_job_id || a.id - b.id)[0];

  if (!ticket) {
    return null;
  }

  const marketJob = state.marketJobs.find(
    (candidate) => candidate.id === ticket.market_job_id,
  );

  return {
    ticket,
    marketCode: marketJob?.marketCode ?? ticket.marketCode ?? `MARKET-${ticket.market_job_id}`,
    marketName: marketJob?.marketName ?? ticket.marketName ?? `Market ${ticket.market_job_id}`,
    dropoff_point: marketJob?.dropoff_point ?? ticket.dropoff_point ?? null,
  };
}

// Function จัดการ activate next ticket สำหรับ vehicle job สำหรับ test
export function activateNextTicketForTicketJob(ticketJobId: number): {
  ticket: BoothJobRecord;
  marketCode: string;
  marketName: string;
  dropoff_point: string | null;
} | null {
  const current = findCurrentOpenTicketForTicketJob(ticketJobId);

  if (!current) {
    return null;
  }

  if (current.ticket.status === "WAIT") {
    current.ticket.status = "WORKING";
    current.ticket.updated_at = new Date().toISOString();
  }

  return current;
}
