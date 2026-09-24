import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { addAdmin, addGateClient, addWorker, getPassword, getWorkerQueue, resetRouteTestState, restoreRouteTestLoader, startRouteTestServer, state, type TestServer } from "../helpers/app-test-harness";

let server: TestServer;
let password: typeof import("../../src/utils/password");
let workerQueue: typeof import("../../src/queues/worker-queue");
/* -------------------------------------- Test Helpers -------------------------------------- */

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

/* -------------------------------------- Test Lifecycle -------------------------------------- */

before(async () => {
  password = await getPassword();
  workerQueue = await getWorkerQueue();
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


test(
  "GET /api/gate/options returns Gate test helper data without financial rates",
  async () => {
    const headers =
      await gateAuthHeaders();

    const response =
      await server.request(
        "GET",
        "/api/gate/options",
        {
          headers,
          external: true,
        }
      );

    assert.equal(
      response.status,
      200
    );

    assert.ok(
      response.body.Markets.length > 0
    );

    assert.ok(
      response.body.Products.length > 0
    );

    assert.deepEqual(
      response.body.Booths,
      []
    );

    const product =
      response.body.Products[0];

    const packageItem =
      product.Packages[0];

    assert.deepEqual(
      Object.keys(packageItem).sort(),
      [
        "PackageCode",
        "PackageName",
        "PackageWeight",
      ]
    );

    assert.equal(
      packageItem.StallRate,
      undefined
    );

    assert.equal(
      packageItem.LaborRate,
      undefined
    );

    assert.equal(
      packageItem.StallPayment,
      undefined
    );

    assert.equal(
      packageItem.WorkerPayment,
      undefined
    );

    const marketResponse =
      await server.request(
        "GET",
        "/api/gate/options?MarketCode=MARKET-001",
        {
          headers,
          external: true,
        }
      );

    assert.equal(
      marketResponse.status,
      200
    );

    assert.equal(
      marketResponse.body.Markets[0]
        .MarketCode,
      "MARKET-001"
    );

    assert.equal(
      marketResponse.body.Booths[0]
        .BoothCode,
      "STALL-001"
    );

    assert.deepEqual(
      marketResponse.body.Products,
      []
    );
  }
);

test("POST /api/gate/tickets requires Gate client credentials", async () => {
  const response = await server.request("POST", "/api/gate/tickets", {
    body: buildBoothJobJobBody("000"),
  });

  assert.equal(response.status, 401);
  assert.equal(response.body.code, "GATE_AUTH_REQUIRED");
});

test("POST /api/gate/tickets rejects invalid Gate client credentials", async () => {
  addGateClient("gate-test", await password.hashPassword("GateSecret@123456"));

  const response = await server.request("POST", "/api/gate/tickets", {
    body: buildBoothJobJobBody("000B"),
    headers: {
      Authorization: `Basic ${Buffer.from("gate-test:wrong-secret").toString("base64")}`,
    },
  });

  assert.equal(response.status, 401);
  assert.equal(response.body.code, "INVALID_GATE_CREDENTIALS");
});

test("POST /api/gate/tickets creates a new Gate ticket", async () => {
  const expectedTicketNumber = toFourteenDigitId("TRUCK-20260723-001");
  const expectedTicketNo = toFourteenDigitId("TKT-20260723-001");
  const response = await server.request("POST", "/api/gate/tickets", {
    body: buildBoothJobJobBody("001"),
    headers: await gateAuthHeaders(),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(Object.keys(response.body).sort(), [
    "Booths",
    "Market",
    "Qr",
    "Result",
    "ServerTime",
    "ServerTimeUnixMs",
    "Ticket",
    "TicketNumber",
    "WorkerCount",
  ]);
  assert.deepEqual(Object.keys(response.body.Ticket).sort(), [
    "BoothCount",
    "LicensePlate",
    "LicensePlateProvince",
    "Status",
    "TicketCreatedAt",
    "TicketNo",
    "VehicleTypeCode",
    "VehicleTypeName",
  ]);
  assert.equal(response.body.Result, "CREATED");
  assert.equal(response.body.TicketNumber, expectedTicketNumber);
  assert.equal(response.body.Ticket.TicketNo, expectedTicketNo);
  assert.equal(response.body.Ticket.TicketCreatedAt, "2026-07-23T07:30:00.000Z");
  assert.equal(response.body.Ticket.BoothCount, 1);
  assert.equal(response.body.Ticket.LicensePlate, "ABC-001");
  assert.equal(response.body.Ticket.LicensePlateProvince, "Bangkok");
  assert.equal(response.body.Ticket.VehicleTypeCode, "PICKUP");
  assert.equal(response.body.Ticket.VehicleTypeName, "Pickup truck");
  assert.equal(response.body.Ticket.Status, "unload_now");
  assert.equal(response.body.Market.MarketCode, "MARKET-001");
  assert.equal(response.body.Market.MarketName, "Market A");
  assert.equal(response.body.Booths.length, 1);

  const firstBooth = response.body.Booths[0];
  const firstProduct = firstBooth.Products[0];

  assert.equal(firstBooth.BoothCode, "STALL-001");
  assert.equal(firstBooth.BoothName, "Vendor A");
  assert.equal(firstBooth.Products.length, 1);
  assert.equal(firstProduct.ProductCode, "02020300");
  assert.equal(firstProduct.ProductFullCode, "02020300000000000000");
  assert.equal(firstProduct.ProductName, "Rambutan");
  assert.equal(firstProduct.PackageCode, "29");
  assert.equal(firstProduct.PackageName, "Crate 20");
  assert.equal(firstProduct.Quantity, 180);
  assert.equal(response.body.WorkerCount, 3);
  assert.equal(firstProduct.WorkerCount, 3);

  assert.equal(firstProduct.StallAmount, undefined);
  assert.equal(firstProduct.WorkerPayment, undefined);
  assert.equal(firstBooth.StallPayment, undefined);
  assert.equal(firstBooth.WorkerPayment, undefined);
  assert.equal(response.body.WorkerPayment, undefined);
  assert.equal(response.body.OrderRemainder, undefined);

  // Gate Create เธ•เนเธญเธ Snapshot Rate เนเธ•เนเธขเธฑเธเธซเนเธฒเธกเธชเธฃเนเธฒเธเน€เธเธดเธเธเธฃเธดเธ
  assert.equal(state.ticketProducts.length, 1);
  assert.equal(state.ticketProducts[0].confirmed_quantity, null);
  assert.notEqual(state.ticketProducts[0].stall_rate_snapshot, null);
  assert.notEqual(state.ticketProducts[0].labor_rate_snapshot, null);
  assert.equal(state.ticketProductFinancials.length, 0);
  assert.equal(state.ticketWorkerPayments.length, 0);

  assert.equal(response.body.Ticket.WorkerQrToken, undefined);
  assert.equal(response.body.Qr.WorkerQrToken, undefined);
  assert.ok(response.body.Qr.DriverQrToken);
  assert.equal(response.body.message, undefined);
  assert.equal(response.body.vehicle_job, undefined);
  assert.equal(response.body.gate_transaction_ref, undefined);
  assert.equal(response.body.markets, undefined);

  assert.equal(state.ticketJobs.length, 1);
  assert.equal(state.ticketJobs[0].ticket_number, expectedTicketNumber);
  assert.equal(state.ticketJobs[0].vehicle_type, "Pickup truck");

  assert.equal(state.marketJobs.length, 1);
  assert.equal(state.marketJobs[0].ticket_no, expectedTicketNo);
  assert.equal(state.marketJobs[0].ticket_created_at, "2026-07-23T07:30:00.000Z");
  assert.equal(state.marketJobs[0].booth_count, 1);
  assert.equal(state.marketJobs[0].ticket_no, response.body.Ticket.TicketNo);

  assert.equal(state.boothJobs.length, 1);
  assert.equal(state.boothJobs[0].marketCode, "MARKET-001");
  assert.equal(state.boothJobs[0].boothCode, "STALL-001");
  assert.equal(state.boothJobs[0].boothName, "Vendor A");
  assert.equal(state.boothJobs[0].vendor_line_id, "line-vendor-stall-001");

  assert.equal(state.ticketProducts.length, 1);
  assert.equal(state.ticketProducts[0].productCode, "02020300");
  assert.equal(state.ticketProducts[0].packageCode, "29");
  assert.equal(state.ticketProducts[0].packageName, "Crate 20");

  const savedProduct = state.ticketProducts[0];
  assert.equal(savedProduct.productFullCode, "02020300000000000000");
  assert.equal(savedProduct.package_weight_snapshot, "20");
  assert.equal(savedProduct.rate_id_snapshot, 1);
  assert.equal(savedProduct.source_rate_id_snapshot, 1);
  assert.equal(savedProduct.rate_market_code, "0000");
  assert.equal(savedProduct.rate_source, "CENTRAL_RATE");
  assert.equal(savedProduct.weight_range_name, "1-25.0");
  assert.equal(savedProduct.weight_min_snapshot, "0");
  assert.equal(savedProduct.weight_max_snapshot, "25");
  assert.equal(savedProduct.stall_rate_snapshot, "1.5");
  assert.equal(savedProduct.labor_rate_snapshot, "0.9");
  assert.ok(savedProduct.rate_snapshot_at);
  assert.equal(savedProduct.confirmed_quantity, null); // Gate Create เธขเธฑเธเนเธกเนเธกเธตเธเธณเธเธงเธเธเธฃเธดเธ

  assert.equal(state.lineMessages.length, 2);
  const gateLineMessage = state.lineMessages[0] as {
    name?: string;
    data?: {
      to?: string;
      messages?: Array<{
        type?: string;
        contents?: unknown;
      }>;
    };
  };

  assert.equal(gateLineMessage.name, "send-gate-ticket-created");
  assert.equal(gateLineMessage.data?.to, "line-vendor-stall-001");

  const gateFlexMessage = gateLineMessage.data?.messages?.[0];
  const gateFlexContents = JSON.stringify(gateFlexMessage?.contents);

  assert.equal(gateFlexMessage?.type, "flex");
  assert.match(gateFlexContents, new RegExp(expectedTicketNo));
  assert.match(gateFlexContents, /ABC-001/);
  assert.match(gateFlexContents, /Rambutan/);
});

test("POST /api/gate/tickets does not dispatch queued workers when Dispatch is false", async () => {
  const worker = addWorker(9700);

  await workerQueue.enqueueWorker(
    worker.id
  );

  const response = await server.request(
    "POST",
    "/api/gate/tickets",
    {
      body: {
        ...buildBoothJobJobBody("006"),
        Dispatch: false,
      },
      headers: await gateAuthHeaders(),
    }
  );

  const queueEntry =
    await workerQueue.getWorkerQueueStatus(
      worker.id
    );

  assert.equal(
    response.status,
    201
  );

  assert.equal(
    response.body.Ticket.Status,
    "waiting_unload"
  );

  // Gate เธขเธฑเธเธ•เธญเธเธเธณเธเธงเธ Worker เธ—เธตเนเธเธฒเธเธ•เนเธญเธเธเธฒเธฃ
  assert.equal(
    response.body.WorkerCount,
    3
  );

  // Dispatch=false เธ•เนเธญเธเธขเธฑเธเนเธกเนเธชเธฃเนเธฒเธ Assignment
  assert.equal(
    state.assignments.length,
    0
  );

  // Worker เธ•เนเธญเธเธขเธฑเธเธญเธขเธนเนเนเธ FIFO queue
  assert.equal(
    queueEntry?.status,
    "ready"
  );
});

test("POST /api/gate/tickets dispatches a ready connected worker to the new Gate job", async () => {
  const worker = addWorker(9701);
  state.connectedWorkers.add(worker.id);
  await workerQueue.enqueueWorker(worker.id);

  const response = await server.request("POST", "/api/gate/tickets", {
    body: buildBoothJobJobBody("007"),
    headers: await gateAuthHeaders(),
  });

  const queueEntry = await workerQueue.getWorkerQueueStatus(worker.id);

  assert.equal(response.status, 201);
  assert.equal(state.ticketJobs.length, 1);
  assert.equal(state.assignments.length, 1);
  assert.equal(state.assignments[0].vehicle_job_id, state.ticketJobs[0].id);
  assert.equal(state.assignments[0].worker_id, worker.id);
  assert.equal(
    state.workerAssignmentEvents.filter(
      (event) =>
        event.assignment_id === state.assignments[0].id &&
        event.event_type === "ASSIGNED"
    ).length,
    1
  );
  assert.equal(queueEntry?.status, "assigned");
  assert.ok(
    state.socketEvents.some(
      (event) => event.workerId === worker.id && event.event === "WORKER_ASSIGNED"
    )
  );
});

test("POST /api/gate/tickets dispatch skips a READY worker who is outside their work shift and ejects them, moving on to the next FIFO worker", async () => {
  // จำลอง worker ที่หลุดเข้าคิวมาทั้งที่นอกกะ (เช่น ถูก Force ไว้ตอนยังอยู่ในกะ แล้วเวลากะผ่านไปโดยไม่มี
  // job มาดีดออกทัน) ด้วยการ enqueue ตรงๆ ผ่าน workerQueue (ข้าม guard ปกติของ endpoint ทุกตัว) เพื่อ
  // พิสูจน์ว่า dispatchReadyWorkers เองมีตาข่ายรองรับดักไว้อีกชั้น ไม่มอบงานให้คนนอกกะเด็ดขาด
  const outsideShiftWorker = addWorker(9691);
  const readyWorker = addWorker(9692);

  state.connectedWorkers.add(outsideShiftWorker.id);
  state.connectedWorkers.add(readyWorker.id);

  const bangkokFormatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const outsideShiftSchedule = state.schedules.get(outsideShiftWorker.id);

  assert.ok(outsideShiftSchedule, "Worker fixture must seed a default work schedule.");
  state.schedules.set(outsideShiftWorker.id, {
    ...(outsideShiftSchedule as object),
    time_in: bangkokFormatter
      .format(new Date(Date.now() + 2 * 60 * 60 * 1000))
      .replace(" ", ""),
    time_out: bangkokFormatter
      .format(new Date(Date.now() + 3 * 60 * 60 * 1000))
      .replace(" ", ""),
  });

  // FIFO: worker นอกกะเข้าคิวก่อน worker ที่พร้อมจริง
  await workerQueue.enqueueWorker(outsideShiftWorker.id);
  await workerQueue.enqueueWorker(readyWorker.id);

  const response = await server.request("POST", "/api/gate/tickets", {
    body: buildBoothJobJobBody("006"),
    headers: await gateAuthHeaders(),
  });

  assert.equal(response.status, 201);
  assert.equal(state.assignments.length, 1);
  assert.equal(state.assignments[0].worker_id, readyWorker.id);

  const outsideShiftQueueEntry = await workerQueue.getWorkerQueueStatus(
    outsideShiftWorker.id
  );
  const readyQueueEntry = await workerQueue.getWorkerQueueStatus(readyWorker.id);

  assert.equal(outsideShiftQueueEntry?.status, "open_app");
  assert.equal(readyQueueEntry?.status, "assigned");
});

test("POST /api/gate/tickets dispatches exactly the required FIFO workers", async () => {
  const workers = Array.from(
    { length: 8 },
    (_, index) =>
      addWorker(9801 + index)
  );

  // เน€เธเนเธฒ FIFO เธ•เธฒเธกเธฅเธณเธ”เธฑเธ 9801 -> 9808
  for (const worker of workers) {
    await workerQueue.enqueueWorker(
      worker.id
    );
  }

  const body = {
    ...buildBoothJobJobBody("004"),

    BoothCount: 2,

    Booths: [
      {
        BoothCode: "STALL-004",

        Products: [
          {
            ProductCode: "02020300",
            PackageCode: "29",
            Quantity: 180,
          },
        ],
      },

      {
        BoothCode: "STALL-004-B",

        Products: [
          {
            ProductCode: "02030103",
            PackageCode: "19",
            Quantity: 100,
          },

          {
            ProductCode: "02011701",
            PackageCode: "19",
            Quantity: 80,
          },
        ],
      },
    ],
  };

  const response = await server.request(
    "POST",
    "/api/gate/tickets",
    {
      body,
      headers: await gateAuthHeaders(),
    }
  );

  /*
   * Worker requirement:
   *
   * Rambutan 180 = 3
   * Cherry   100 = 2
   * Melon     80 = 2
   *
   * เธฃเธงเธก = 7
   */
  assert.equal(
    response.status,
    201
  );

  assert.equal(
    response.body.WorkerCount,
    3
  );

  assert.equal(
    state.ticketJobs[0]
      .workers_required,
    3
  );

  // เธ•เนเธญเธเธชเธฃเนเธฒเธ Assignment เน€เธ—เนเธฒเธเธณเธเธงเธเธ—เธตเน Gate เธ•เนเธญเธเธเธฒเธฃ
  assert.equal(
    state.assignments.length,
    3
  );

  // เธ•เนเธญเธเน€เธเนเธ Worker 7 เธเธเนเธฃเธเธ•เธฒเธก FIFO
  assert.deepEqual(
    state.assignments.map(
      (assignment) =>
        assignment.worker_id
    ),
    workers
      .slice(0, 3)
      .map((worker) => worker.id)
  );

  // Worker เธเธเธ—เธตเน 8 เธ•เนเธญเธเนเธกเนเธ–เธนเธเธ”เธถเธเน€เธเธดเธเธเธณเธเธงเธ
  const remainingWorker =
    await workerQueue
      .getWorkerQueueStatus(
        workers[3].id
      );

  assert.equal(
    remainingWorker?.status,
    "ready"
  );

  // 7 เธเธเนเธฃเธเธ•เนเธญเธเธ–เธนเธ mark assigned
  for (
    const worker
    of workers.slice(0, 3)
  ) {
    const queueEntry =
      await workerQueue
        .getWorkerQueueStatus(
          worker.id
        );

    assert.equal(
      queueEntry?.status,
      "assigned"
    );
  }
});

test("POST /api/gate/tickets replays the same Gate request", async () => {
  const body = buildBoothJobJobBody("002");
  const headers = await gateAuthHeaders();

  const created = await server.request("POST", "/api/gate/tickets", {
    body,
    headers,
  });
  const replayed = await server.request("POST", "/api/gate/tickets", {
    body,
    headers,
  });

  assert.equal(created.status, 201);
  assert.equal(replayed.status, 200);
  assert.deepEqual(Object.keys(replayed.body).sort(), [
    "Booths",
    "Market",
    "Qr",
    "Result",
    "ServerTime",
    "ServerTimeUnixMs",
    "Ticket",
    "TicketNumber",
    "WorkerCount",
  ]);
  assert.equal(replayed.body.Result, "REPLAYED");
  assert.equal(replayed.body.Ticket.TicketNo, toFourteenDigitId("TKT-20260723-002"));
  assert.equal(replayed.body.Ticket.Status, "unload_now");
  assert.equal(replayed.body.Market.MarketCode, "MARKET-002");
  assert.equal(replayed.body.Booths[0].BoothCode, "STALL-002");
  assert.equal(replayed.body.Booths[0].Products[0].ProductCode, "02020300");
  assert.equal(replayed.body.WorkerCount, 3);
  assert.equal(replayed.body.message, undefined);
  assert.equal(replayed.body.vehicle_job, undefined);
  assert.equal(replayed.body.idempotency_key, undefined);
  assert.equal(replayed.body.duplicate_field, undefined);
  assert.equal(replayed.body.markets, undefined);
  assert.equal(state.ticketJobs.length, 1);
});

test("POST /api/gate/tickets rejects re-adding a BoothCode that already exists in the Ticket, even when other fields differ", async () => {
  // TicketNo + ตลาดเดิมซ้ำกันตอนนี้หมายถึง Append เข้า Ticket เดิม (ดู test "appends a new booth...")
  // แต่ถ้า BoothCode ที่ส่งมาชนกับแผงที่มีอยู่แล้วในตลาดเดิมนั้น ต้อง Reject เสมอ ไม่ว่า field อื่นจะ
  // ต่างกันแค่ไหนก็ตาม (ไม่รองรับการ merge สินค้าเข้าแผงเดิม)
  const body = buildBoothJobJobBody("003");
  const headers = await gateAuthHeaders();

  await server.request("POST", "/api/gate/tickets", {
    body,
    headers,
  });

  const mismatch = await server.request("POST", "/api/gate/tickets", {
    body: {
      ...body,
      LicensePlate: "DIFFERENT-003",
    },
    headers,
  });

  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.code, "GATE_BOOTH_ALREADY_EXISTS_IN_TICKET");
});

test("POST /api/gate/tickets creates multiple booths and products in one request", async () => {
  const body = {
    ...buildBoothJobJobBody("004"),
    BoothCount: 2,
    Booths: [
      {
        BoothCode: "STALL-004",
        Products: [
          {
            ProductCode: "02020300",
            PackageCode: "29",
            Quantity: 180,
          },
        ],
      },
      {
        BoothCode: "STALL-004-B",
        Products: [
          {
            ProductCode: "02030103",
            PackageCode: "19",
            Quantity: 100,
          },
          {
            ProductCode: "02011701",
            PackageCode: "19",
            Quantity: 80,
          },
        ],
      },
    ],
  };

  const response = await server.request("POST", "/api/gate/tickets", {
    body,
    headers: await gateAuthHeaders(),
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.Result, "CREATED");
  assert.equal(response.body.Ticket.TicketNo, toFourteenDigitId("TKT-20260723-004"));
  assert.equal(response.body.Ticket.BoothCount, 2);
  assert.equal(response.body.Booths.length, 2);

  assert.equal(response.body.Booths[0].BoothCode, "STALL-004");
  assert.equal(response.body.Booths[0].BoothName, "Vendor A");
  assert.equal(response.body.Booths[0].Products.length, 1);

  assert.equal(response.body.Booths[1].BoothCode, "STALL-004-B");
  assert.equal(response.body.Booths[1].BoothName, "Vendor B");
  assert.equal(response.body.Booths[1].Products.length, 2);
  assert.equal(response.body.Booths[1].Products[0].ProductCode, "02030103");
  assert.equal(response.body.Booths[1].Products[1].ProductCode, "02011701");

  assert.equal(response.body.Booths[0].StallPayment, undefined);
  assert.equal(response.body.Booths[1].StallPayment, undefined);

  // MAX(3, 2, 2) = 3 (ต่อ Ticket ใช้ MAX ของทุก Product ในทุกแผง ไม่ใช่ SUM แล้ว)
  assert.equal(response.body.WorkerCount, 3);
  assert.equal(response.body.WorkerPayment, undefined);
  assert.equal(response.body.OrderRemainder, undefined);

  for (const booth of response.body.Booths) {
    for (const product of booth.Products) {
      assert.equal(product.StallAmount, undefined);
      assert.equal(product.WorkerPayment, undefined);
    }
  }

  assert.equal(state.ticketJobs.length, 1);
  assert.equal(state.ticketJobs[0].workers_required, 3);
  assert.equal(state.marketJobs.length, 1);
  assert.equal(state.marketJobs[0].booth_count, 2);

  assert.equal(state.boothJobs.length, 2);
  assert.equal(state.boothJobs[0].boothCode, "STALL-004");
  assert.equal(state.boothJobs[1].boothCode, "STALL-004-B");

  assert.equal(state.ticketProducts.length, 3);
  assert.deepEqual(
    state.ticketProducts.map((product) => product.productCode),
    ["02020300", "02030103", "02011701"]
  );

  assert.equal(state.lineMessages.length, 4);
  const vendorBMessages = state.lineMessages.filter((message) => {
    const data = (message as { data?: { to?: string } }).data;
    return data?.to === "line-vendor-stall-004-b";
  });

  assert.equal(vendorBMessages.length, 1);
  assert.match(
    JSON.stringify(
      (vendorBMessages[0] as {
        data?: {
          messages?: Array<{
            contents?: unknown;
          }>;
        };
      }).data?.messages?.[0]?.contents
    ),
    /Cherry|Melon/
  );
});

test("POST /api/gate/tickets rejects BoothCount mismatch", async () => {
  const response = await server.request("POST", "/api/gate/tickets", {
    body: {
      ...buildBoothJobJobBody("008"),
      BoothCount: 2,
    },
    headers: await gateAuthHeaders(),
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.code, "VALIDATION_ERROR");
});

test("POST /api/gate/tickets rejects duplicate BoothCode in the same request", async () => {
  const base = buildBoothJobJobBody("010");

  const response = await server.request("POST", "/api/gate/tickets", {
    body: {
      ...base,
      BoothCount: 2,
      Booths: [
        base.Booths[0],
        {
          BoothCode: base.Booths[0].BoothCode,
          Products: [
            {
              ProductCode: "02020300",
              PackageCode: "29",
              Quantity: 100,
            },
          ],
        },
      ],
    },
    headers: await gateAuthHeaders(),
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.code, "VALIDATION_ERROR");
});

test("POST /api/gate/tickets rejects duplicate ProductCode + PackageCode in the same booth", async () => {
  const base = buildBoothJobJobBody("012");

  const response = await server.request("POST", "/api/gate/tickets", {
    body: {
      ...base,
      Booths: [
        {
          BoothCode: "STALL-012",
          Products: [
            {
              ProductCode: "02020300",
              PackageCode: "29",
              Quantity: 180,
            },
            {
              ProductCode: "02020300",
              PackageCode: "29",
              Quantity: 100,
            },
          ],
        },
      ],
    },
    headers: await gateAuthHeaders(),
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.code, "VALIDATION_ERROR");
});

/* -------------------------------------- TicketNumber -> Ticket (Business Ticket) Route Tests -------------------------------------- */

test("POST /api/gate/tickets creates multiple Business Tickets under the same TicketNumber without creating a new TicketJob, aggregating WorkerCount by SUM", async () => {
  const headers = await gateAuthHeaders();
  const ticketNumber = toFourteenDigitId("TRUCK-MULTI-001");

  const first = await server.request("POST", "/api/gate/tickets", {
    body: {
      TicketNumber: ticketNumber,
      TicketNo: toFourteenDigitId("TKT-MULTI-001"),
      TicketCreatedAt: "2026-07-23T14:30:00+07:00",
      BoothCount: 1,
      MarketCode: "MARKET-010",
      DropoffPoint: "Test Dropoff",
      LicensePlate: "MULTI-001",
      LicensePlateProvince: "Bangkok",
      VehicleTypeCode: "PICKUP",
      VehicleTypeName: "Pickup truck",
      Booths: [
        {
          BoothCode: "STALL-010",
          Products: [{ ProductCode: "02020300", PackageCode: "29", Quantity: 180 }],
        },
      ],
      Dispatch: true,
    },
    headers,
  });

  assert.equal(first.status, 201);
  assert.equal(first.body.TicketNumber, ticketNumber);
  assert.equal(first.body.WorkerCount, 3);

  const second = await server.request("POST", "/api/gate/tickets", {
    body: {
      TicketNumber: ticketNumber,
      TicketNo: toFourteenDigitId("TKT-MULTI-002"),
      TicketCreatedAt: "2026-07-23T14:35:00+07:00",
      BoothCount: 1,
      MarketCode: "MARKET-011",
      DropoffPoint: "Test Dropoff",
      LicensePlate: "MULTI-001",
      LicensePlateProvince: "Bangkok",
      VehicleTypeCode: "PICKUP",
      VehicleTypeName: "Pickup truck",
      Booths: [
        {
          BoothCode: "STALL-011",
          Products: [{ ProductCode: "02030103", PackageCode: "19", Quantity: 100 }],
        },
      ],
      Dispatch: true,
    },
    headers,
  });

  assert.equal(second.status, 201);
  assert.equal(second.body.TicketNumber, ticketNumber);

  // ต้องยังเป็น TicketJob เดียว (TicketNumber เดียวกัน) ไม่สร้างใหม่ซ้ำ
  assert.equal(
    state.ticketJobs.filter((job) => job.ticket_number === ticketNumber).length,
    1
  );
  assert.equal(
    state.marketJobs.filter((market) => market.vehicle_job_id === state.ticketJobs.find((j) => j.ticket_number === ticketNumber)!.id).length,
    2
  );

  // Worker requirement ของ TicketNumber = SUM ของทุก Business Ticket ห้ามใช้ MAX
  const ticketJob = state.ticketJobs.find((job) => job.ticket_number === ticketNumber)!;
  const marketJobsOfVehicle = state.marketJobs.filter(
    (market) => market.vehicle_job_id === ticketJob.id
  );
  const sumOfMarketWorkersRequired = marketJobsOfVehicle.reduce(
    (total, market) => total + market.workers_required,
    0
  );

  assert.equal(ticketJob.workers_required, sumOfMarketWorkersRequired);
  // WorkerCount ที่ Gate response คืนกลับต้องเป็นยอดรวมสะสมของทั้ง TicketNumber (ไม่ใช่แค่ Ticket ล่าสุด)
  assert.equal(second.body.WorkerCount, ticketJob.workers_required);
  assert.notEqual(ticketJob.workers_required, Math.max(...marketJobsOfVehicle.map((m) => m.workers_required)));
});

test("POST /api/gate/tickets replay/mismatch idempotency is keyed by TicketNumber+TicketNo, never rejects a new TicketNo under the same TicketNumber, but still rejects the same TicketNo reused for a different market", async () => {
  const headers = await gateAuthHeaders();
  const ticketNumber = toFourteenDigitId("TRUCK-MULTI-002");
  const buildBody = (ticketNo: string, marketSuffix: string) => ({
    TicketNumber: ticketNumber,
    TicketNo: toFourteenDigitId(ticketNo),
    TicketCreatedAt: "2026-07-23T14:30:00+07:00",
    BoothCount: 1,
    MarketCode: `MARKET-${marketSuffix}`,
    DropoffPoint: "Test Dropoff",
    LicensePlate: "MULTI-002",
    LicensePlateProvince: "Bangkok",
    VehicleTypeCode: "PICKUP",
    VehicleTypeName: "Pickup truck",
    Booths: [
      {
        BoothCode: `STALL-${marketSuffix}`,
        Products: [{ ProductCode: "02020300", PackageCode: "29", Quantity: 180 }],
      },
    ],
    Dispatch: true,
  });

  const created = await server.request("POST", "/api/gate/tickets", {
    body: buildBody("TKT-A", "012"),
    headers,
  });

  assert.equal(created.status, 201);

  // Payload เดิมทุกอย่าง (TicketNumber+TicketNo+ตลาดเดิม) -> REPLAYED
  const replayed = await server.request("POST", "/api/gate/tickets", {
    body: buildBody("TKT-A", "012"),
    headers,
  });

  assert.equal(replayed.status, 200);
  assert.equal(replayed.body.Result, "REPLAYED");

  // TicketNumber เดิม แต่ TicketNo ใหม่ -> ต้องสร้าง Ticket ใหม่เสมอ ห้าม Reject
  const differentTicketNo = await server.request("POST", "/api/gate/tickets", {
    body: buildBody("TKT-B", "013"),
    headers,
  });

  assert.equal(differentTicketNo.status, 201);
  assert.equal(differentTicketNo.body.Result, "CREATED");

  // TicketNumber+TicketNo เดิม ("TKT-A") แต่เป็นคนละตลาด ("099" ไม่ใช่ "012") -> ยังต้อง Reject เหมือนเดิม
  // (ตลาดเดียวกันเท่านั้นที่อนุญาตให้ส่ง TicketNo ซ้ำได้เพื่อ Append ดู test "appends a new booth..."
  // ถ้าคนละตลาดต้องให้ Admin ยกเลิก Ticket เดิมก่อนถึงจะส่ง TicketNo นี้ซ้ำได้ ดู test
  // "cancel then recreate...")
  const sameTicketNoDifferentMarket = await server.request("POST", "/api/gate/tickets", {
    body: buildBody("TKT-A", "099"),
    headers,
  });

  assert.equal(sameTicketNoDifferentMarket.status, 409);
  assert.equal(sameTicketNoDifferentMarket.body.code, "GATE_TICKET_ALREADY_EXISTS");
});

test("POST /api/gate/tickets appends a new booth into the same Ticket when TicketNo and market both repeat, but rejects a repeated BoothCode", async () => {
  const headers = await gateAuthHeaders();
  const ticketNumber = toFourteenDigitId("TRUCK-APPEND-001");
  const ticketNo = toFourteenDigitId("TKT-APPEND-001");
  const buildBody = (
    boothCode: string,
    productCode: string,
    packageCode: string,
    quantity: number,
  ) => ({
    TicketNumber: ticketNumber,
    TicketNo: ticketNo,
    TicketCreatedAt: "2026-07-23T14:30:00+07:00",
    BoothCount: 1,
    // MARKET-004 มี Booth ที่ seed ไว้ 2 ตัวคือ STALL-004 กับ STALL-004-B — ใช้ตลาดนี้เพื่อให้มี
    // BoothCode ที่สองที่ resolve กับ master data ได้จริงสำหรับทดสอบ Append
    MarketCode: "MARKET-004",
    DropoffPoint: "Test Dropoff",
    LicensePlate: "APPEND-001",
    LicensePlateProvince: "Bangkok",
    VehicleTypeCode: "PICKUP",
    VehicleTypeName: "Pickup truck",
    Booths: [
      {
        BoothCode: boothCode,
        Products: [{ ProductCode: productCode, PackageCode: packageCode, Quantity: quantity }],
      },
    ],
    Dispatch: true,
  });

  // Cherry qty 100 ใช้คน 2 -> booth แรกของ Ticket ใช้คน 2
  const first = await server.request("POST", "/api/gate/tickets", {
    body: buildBody("STALL-004", "02030103", "19", 100),
    headers,
  });

  assert.equal(first.status, 201);

  const ticketJobBeforeAppend = state.ticketJobs.find((job) => job.ticket_number === ticketNumber)!;
  const marketJobBeforeAppend = state.marketJobs.find((market) => market.vehicle_job_id === ticketJobBeforeAppend.id)!;
  // Snapshot เป็นค่า primitive ไว้ก่อน เพราะ marketJobBeforeAppend เป็น object reference เดียวกับที่
  // จะถูก mutate ตอน append (state.marketJobs ไม่ได้ clone) อ่านทีหลังจะได้ค่า "after" ไปแล้ว
  const workersRequiredBeforeAppend = marketJobBeforeAppend.workers_required;

  // TicketNo + ตลาดเดิม แต่ BoothCode ใหม่ (ไม่ชนของเดิม) -> Append เข้า Ticket เดิม ไม่สร้างใบใหม่
  // Rambutan qty 180 ใช้คน 3 (มากกว่า booth แรก) -> workers_required ของ Ticket ต้องขยับขึ้นเป็น MAX ใหม่
  const appended = await server.request("POST", "/api/gate/tickets", {
    body: buildBody("STALL-004-B", "02020300", "29", 180),
    headers,
  });

  assert.equal(appended.status, 201);
  assert.equal(
    state.marketJobs.filter((market) => market.vehicle_job_id === ticketJobBeforeAppend.id).length,
    1,
    "ต้องยังเป็น MarketJob ใบเดิม ไม่สร้างใหม่"
  );

  const marketJobAfterAppend = state.marketJobs.find((market) => market.id === marketJobBeforeAppend.id)!;

  // MAX(2, 3) = 3 -- Append เอา MAX ระหว่างของเดิมกับของคำขอนี้ (แผงเดิมไม่ถูกแตะ ค่าเดิมยังถูกต้องอยู่)
  assert.equal(workersRequiredBeforeAppend, 2);
  assert.equal(marketJobAfterAppend.workers_required, 3);
  assert.equal(marketJobAfterAppend.booth_count, 2);
  assert.equal(
    state.boothJobs.filter((ticket) => ticket.market_job_id === marketJobBeforeAppend.id).length,
    2
  );

  // ส่ง BoothCode ที่มีอยู่แล้วใน Ticket นี้ซ้ำ -> Reject (เปลี่ยน LicensePlate ให้ payload ไม่ตรงกับ
  // request แรกเป๊ะๆ ไม่งั้นจะถูกจับเป็น REPLAYED ก่อนถึง booth-collision guard)
  const duplicateBooth = await server.request("POST", "/api/gate/tickets", {
    body: { ...buildBody("STALL-004", "02030103", "19", 100), LicensePlate: "APPEND-001-RETRY" },
    headers,
  });

  assert.equal(duplicateBooth.status, 409);
  assert.equal(duplicateBooth.body.code, "GATE_BOOTH_ALREADY_EXISTS_IN_TICKET");
});

test("POST /api/gate/tickets sets ticketsClosedAt immediately on the very first Ticket created, without any TicketCount", async () => {
  const headers = await gateAuthHeaders();
  const ticketNumber = toFourteenDigitId("TRUCK-CLOSE-001");

  const response = await server.request("POST", "/api/gate/tickets", {
    body: {
      TicketNumber: ticketNumber,
      TicketNo: toFourteenDigitId("TKT-CLOSE-001"),
      TicketCreatedAt: "2026-07-23T14:30:00+07:00",
      BoothCount: 1,
      MarketCode: "MARKET-005",
      DropoffPoint: "Test Dropoff",
      LicensePlate: "CLOSE-001",
      LicensePlateProvince: "Bangkok",
      VehicleTypeCode: "PICKUP",
      VehicleTypeName: "Pickup truck",
      Booths: [
        {
          BoothCode: "STALL-005",
          Products: [{ ProductCode: "02020300", PackageCode: "29", Quantity: 180 }],
        },
      ],
      Dispatch: true,
    },
    headers,
  });

  assert.equal(response.status, 201);

  const ticketJob = state.ticketJobs.find((job) => job.ticket_number === ticketNumber)!;

  assert.ok(ticketJob.tickets_closed_at);
  assert.equal(ticketJob.expected_ticket_count, 1);
});

test("POST /api/gate/tickets allows the same TicketNo to be reused after an Admin cancels the Ticket, keeping the cancelled Ticket as history", async () => {
  const headers = await gateAuthHeaders();
  const { token: adminToken } = await loginJobAdmin(9701);
  const ticketNumber = toFourteenDigitId("TRUCK-CANCEL-REUSE-001");
  const ticketNo = toFourteenDigitId("TKT-CANCEL-REUSE-001");
  const buildBody = (marketCode: string, boothCode: string, productCode: string, packageCode: string, quantity: number) => ({
    TicketNumber: ticketNumber,
    TicketNo: ticketNo,
    TicketCreatedAt: "2026-07-23T14:30:00+07:00",
    BoothCount: 1,
    MarketCode: marketCode,
    DropoffPoint: "Test Dropoff",
    LicensePlate: "CANCEL-REUSE-001",
    LicensePlateProvince: "Bangkok",
    VehicleTypeCode: "PICKUP",
    VehicleTypeName: "Pickup truck",
    Booths: [
      {
        BoothCode: boothCode,
        Products: [{ ProductCode: productCode, PackageCode: packageCode, Quantity: quantity }],
      },
    ],
    Dispatch: true,
  });

  const first = await server.request("POST", "/api/gate/tickets", {
    body: buildBody("MARKET-007", "STALL-007", "02020300", "29", 180),
    headers,
  });

  assert.equal(first.status, 201);

  // ส่ง TicketNo เดิมซ้ำขณะที่ Ticket แรกยัง active แต่คนละตลาด (MARKET-008 ไม่ใช่ MARKET-007) -> Reject
  // เสมอ (TicketNo ซ้ำได้เฉพาะตลาดเดียวกันเท่านั้น ถึงจะเป็น Append ได้)
  const rejectedWhileActive = await server.request("POST", "/api/gate/tickets", {
    body: { ...buildBody("MARKET-008", "STALL-008", "02030103", "19", 100), LicensePlate: "CANCEL-REUSE-001-RETRY" },
    headers,
  });

  assert.equal(rejectedWhileActive.status, 409);
  assert.equal(rejectedWhileActive.body.code, "GATE_TICKET_ALREADY_EXISTS");

  const originalMarketJob = state.marketJobs.find((market) => market.ticket_no === ticketNo)!;
  const originalMarketJobId = originalMarketJob.id;

  const cancelResponse = await server.request(
    "POST",
    "/api/admin/vehicle-jobs/assignment/cancel",
    { token: adminToken, body: { ticket_number: ticketNumber, ticket_no: ticketNo, reason_code: "test" } },
  );

  assert.equal(cancelResponse.status, 200);
  assert.equal(
    state.marketJobs.find((market) => market.id === originalMarketJobId)!.status,
    "CANCELLED"
  );

  // TicketNo เดิมว่างแล้วหลังถูกยกเลิก -> Gate สร้าง Business Ticket ใหม่ด้วย TicketNo เดิม (แม้กับ
  // ตลาดเดิม MARKET-007 ที่เพิ่งถูกยกเลิกไป) ได้ทันที
  const recreated = await server.request("POST", "/api/gate/tickets", {
    body: { ...buildBody("MARKET-007", "STALL-007", "02030103", "19", 100), LicensePlate: "CANCEL-REUSE-001-NEW" },
    headers,
  });

  assert.equal(recreated.status, 201);
  assert.equal(recreated.body.Result, "CREATED");
  assert.equal(recreated.body.Ticket.TicketNo, ticketNo);

  // รถต้องถูกเปิดกลับมาทำงาน (ไม่ค้างสถานะ terminal จากการยกเลิกทุก Business Ticket) ไม่งั้น dispatch ไม่หยิบรถคันนี้
  const reopenedVehicle = state.ticketJobs.find((job) => job.ticket_number === ticketNumber)!;
  assert.equal(reopenedVehicle.status, "WORKING");
  assert.equal(reopenedVehicle.dispatch_now, true);

  // แถวเดิมที่ถูกยกเลิกยังอยู่เป็นประวัติ ไม่ถูกลบหรือใช้ซ้ำในที่เดิม + มีแถวใหม่แยกต่างหากที่ active
  const marketJobsWithSameTicketNo = state.marketJobs.filter(
    (market) => market.ticket_no === ticketNo
  );

  assert.equal(marketJobsWithSameTicketNo.length, 2);
  assert.ok(marketJobsWithSameTicketNo.some((market) => market.id === originalMarketJobId && market.status === "CANCELLED"));
  assert.ok(
    marketJobsWithSameTicketNo.some((market) => market.id !== originalMarketJobId && market.status !== "CANCELLED")
  );
});

/* -------------------------------------- DropoffPoint Route Tests -------------------------------------- */
//
// DropoffPoint เป็นแค่ข้อมูลที่ Gate ส่งมาต่อ Ticket เก็บลง MarketJob.dropoff_point ตรงๆ เหมือนฟิลด์
// อื่นๆ ของ Ticket (ไม่มี table แยก ไม่มีการบังคับ unique ข้าม Ticket/ตลาด) — คนละ Ticket จึงมีค่าต่าง
// กันได้อิสระ แม้จะเป็นตลาดเดียวกันหรือค่าเดียวกันกับตลาดอื่นก็ตาม

test("POST /api/gate/tickets stores the DropoffPoint sent for this Ticket", async () => {
  const response = await server.request("POST", "/api/gate/tickets", {
    body: { ...buildBoothJobJobBody("005"), DropoffPoint: "Gate 3 - Zone B" },
    headers: await gateAuthHeaders(),
  });

  assert.equal(response.status, 201);

  const marketJob = state.marketJobs.find((market) => market.marketCode === "MARKET-005");
  assert.equal(marketJob?.dropoff_point, "Gate 3 - Zone B");
});

test("POST /api/gate/tickets rejects a request missing DropoffPoint", async () => {
  const { DropoffPoint: _omitted, ...bodyWithoutDropoffPoint } = buildBoothJobJobBody("006");

  const response = await server.request("POST", "/api/gate/tickets", {
    body: bodyWithoutDropoffPoint,
    headers: await gateAuthHeaders(),
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.code, "VALIDATION_ERROR");
});

test("POST /api/gate/tickets allows different Tickets of the same market to record different DropoffPoint values", async () => {
  const headers = await gateAuthHeaders();

  const first = await server.request("POST", "/api/gate/tickets", {
    body: {
      ...buildBoothJobJobBody("007-A"),
      MarketCode: "MARKET-007",
      Booths: [
        {
          BoothCode: "STALL-007",
          Products: [{ ProductCode: "02020300", PackageCode: "29", Quantity: 180 }],
        },
      ],
      DropoffPoint: "Gate 1 - Zone A",
    },
    headers,
  });

  assert.equal(first.status, 201);

  const second = await server.request("POST", "/api/gate/tickets", {
    body: {
      ...buildBoothJobJobBody("007-B"),
      MarketCode: "MARKET-007",
      Booths: [
        {
          BoothCode: "STALL-007",
          Products: [{ ProductCode: "02020300", PackageCode: "29", Quantity: 180 }],
        },
      ],
      DropoffPoint: "Gate 2 - Zone C",
    },
    headers,
  });

  assert.equal(second.status, 201);

  const marketJobsForMarket007 = state.marketJobs
    .filter((market) => market.marketCode === "MARKET-007")
    .map((market) => market.dropoff_point);

  assert.deepEqual(marketJobsForMarket007.sort(), ["Gate 1 - Zone A", "Gate 2 - Zone C"]);
});

/* -------------------------------------- Admin Worker Status Route Tests -------------------------------------- */
