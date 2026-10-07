// Import Library
import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
// Import Helpers
import { addAdmin, addGateClient, addWorker, getPassword, getWorkerQueue, resetRouteTestState, restoreRouteTestLoader, startRouteTestServer, state, type TestServer } from "../helpers/app-test-harness";
import { gateRepositoryMock } from "../helpers/app-test-repository-mocks";

let server: TestServer;
let password: typeof import("../../src/utils/password");
let workerQueue: typeof import("../../src/queues/worker-queue");

/* -------------------------------------- Test Helpers -------------------------------------- */

// Type สินค้าใน body ของ Gate
type GateProductBody = {
  ProductCode: string;
  PackageCode: string;
  Quantity: number;
};

// Type แผงใน body ของ Gate
type GateBoothBody = {
  BoothCode: string;
  Products: GateProductBody[];
};

// Function สร้างเลข 14 หลักจาก seed (seed เดิมได้เลขเดิมเสมอ)
function toFourteenDigitId(seed: string): string {
  let hash = 0;

  for (let index = 0; index < seed.length; index++) {
    hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
  }

  return String(hash).padStart(14, "0");
}

// Function สร้างสินค้า 1 รายการของ Gate
function product(productCode: string, packageCode: string, quantity: number): GateProductBody {
  return {
    ProductCode: productCode,
    PackageCode: packageCode,
    Quantity: quantity,
  };
}

// Function สร้างตั๋ว 1 ใบ (1 ตลาด) ของ Gate
function buildTicket(
  suffix: string,
  overrides: Partial<{
    TicketNo: string;
    TicketCreatedAt: string;
    MarketCode: string;
    DropoffPoint: string;
    Booths: GateBoothBody[];
  }> = {}
) {
  return {
    TicketNo: toFourteenDigitId(`TKT-20260723-${suffix}`),
    TicketCreatedAt: "2026-07-23T14:30:00+07:00",
    MarketCode: `MARKET-${suffix}`,
    DropoffPoint: `Dropoff-${suffix}`,
    Booths: [
      {
        BoothCode: `STALL-${suffix}`,
        Products: [product("02020300", "29", 180)],
      },
    ],
    ...overrides,
  };
}

// Function สร้าง body สร้างงานรถของ Gate (ค่าเริ่มต้น 1 ตลาด)
function buildBoothJobJobBody(
  suffix: string,
  overrides: Record<string, unknown> = {}
) {
  return {
    TicketNumber: toFourteenDigitId(`TRUCK-20260723-${suffix}`),
    GateNo: "G01",
    LicensePlate: `ABC-${suffix}`,
    LicensePlateProvince: "Bangkok",
    VehicleTypeCode: "PICKUP",
    VehicleTypeName: "Pickup truck",
    Markets: [buildTicket(suffix)],
    Dispatch: true,
    ...overrides,
  };
}

// Function สร้าง Gate auth headers
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

// Function login job admin
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

// Function ดึงชื่อ job ของ LINE message ตามลำดับที่ส่ง (กรองตามผู้รับได้)
function lineMessageNames(to?: string): string[] {
  return state.lineMessages
    .map((message) => message as { name?: string; data?: { to?: string } })
    .filter((message) => !to || message.data?.to === to)
    .map((message) => message.name ?? "");
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

test("POST /api/gate/tickets creates a new Gate ticket and echoes GateNo", async () => {
  const expectedTicketNumber = toFourteenDigitId("TRUCK-20260723-001");
  const expectedTicketNo = toFourteenDigitId("TKT-20260723-001");
  const response = await server.request("POST", "/api/gate/tickets", {
    body: buildBoothJobJobBody("001", { GateNo: "G03" }),
    headers: await gateAuthHeaders(),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(Object.keys(response.body).sort(), [
    "GateNo",
    "Markets",
    "Qr",
    "Result",
    "ServerTime",
    "ServerTimeUnixMs",
    "TicketNumber",
    "Vehicle",
    "WorkerCount",
  ]);
  assert.deepEqual(Object.keys(response.body.Vehicle).sort(), [
    "LicensePlate",
    "LicensePlateProvince",
    "Status",
    "VehicleTypeCode",
    "VehicleTypeName",
  ]);
  assert.equal(response.body.Result, "CREATED");
  assert.equal(response.body.TicketNumber, expectedTicketNumber);
  assert.equal(response.body.GateNo, "G03");
  assert.equal(response.body.Vehicle.LicensePlate, "ABC-001");
  assert.equal(response.body.Vehicle.LicensePlateProvince, "Bangkok");
  assert.equal(response.body.Vehicle.VehicleTypeCode, "PICKUP");
  assert.equal(response.body.Vehicle.VehicleTypeName, "Pickup truck");
  assert.equal(response.body.Vehicle.Status, "unload_now");
  assert.equal(response.body.Markets.length, 1);

  const market = response.body.Markets[0];

  assert.equal(market.TicketNo, expectedTicketNo);
  assert.equal(market.TicketCreatedAt, "2026-07-23T07:30:00.000Z");
  assert.equal(market.MarketCode, "MARKET-001");
  assert.equal(market.MarketName, "Market A");
  assert.equal(market.DropoffPoint, "Dropoff-001");
  assert.equal(market.BoothCount, 1);
  assert.equal(market.WorkerCount, 3);
  assert.equal(market.Booths.length, 1);

  const firstBooth = market.Booths[0];
  const firstProduct = firstBooth.Products[0];

  assert.equal(firstBooth.BoothCode, "STALL-001");
  assert.equal(firstBooth.BoothName, "Vendor A");
  assert.equal(firstProduct.ProductCode, "02020300");
  assert.equal(firstProduct.ProductFullCode, "02020300000000000000");
  assert.equal(firstProduct.ProductName, "Rambutan");
  assert.equal(firstProduct.PackageCode, "29");
  assert.equal(firstProduct.PackageName, "Crate 20");
  assert.equal(firstProduct.Quantity, 180);
  assert.equal(firstProduct.WorkerCount, 3);
  assert.equal(response.body.WorkerCount, 3);

  assert.equal(firstProduct.StallAmount, undefined);
  assert.equal(firstProduct.WorkerPayment, undefined);
  assert.equal(firstBooth.StallPayment, undefined);
  assert.equal(response.body.WorkerPayment, undefined);
  assert.ok(response.body.Qr.DriverQrToken);
  assert.equal(response.body.Qr.WorkerQrToken, undefined);

  // Gate Create ต้อง Snapshot Rate และจำนวน Worker แต่ยังห้ามสร้างเงินจริง
  assert.equal(state.ticketProducts.length, 1);
  assert.equal(state.ticketProducts[0].confirmed_quantity, null);
  assert.equal(state.ticketProducts[0].required_worker_count_snapshot, 3);
  assert.equal(state.ticketProducts[0].stall_rate_snapshot, "1.5");
  assert.equal(state.ticketProducts[0].labor_rate_snapshot, "0.9");
  assert.equal(state.ticketProducts[0].rate_source, "CENTRAL_RATE");
  assert.equal(state.ticketProductFinancials.length, 0);
  assert.equal(state.ticketWorkerPayments.length, 0);

  // บันทึก Gate ที่ออกตั๋วทั้งที่ตั๋วและ request log
  const gateClient = state.gateClients.get("gate-test") as { id: number };

  assert.equal(state.ticketJobs.length, 1);
  assert.equal(state.ticketJobs[0].vehicle_type_code, "PICKUP");
  assert.equal(state.marketJobs.length, 1);
  assert.equal(state.marketJobs[0].ticket_no, expectedTicketNo);
  assert.equal(state.marketJobs[0].gate_no, "G03");
  assert.equal(state.marketJobs[0].gate_client_id, gateClient.id);
  assert.equal(state.gateRequestLogs.length, 1);
  assert.equal(state.gateRequestLogs[0].request_type, "CREATE");
  assert.equal(state.gateRequestLogs[0].gate_no, "G03");
  assert.equal(state.gateRequestLogs[0].gate_client_id, gateClient.id);

  assert.equal(state.boothJobs.length, 1);
  assert.equal(state.boothJobs[0].vendor_line_id, "line-vendor-stall-001");
  assert.deepEqual(lineMessageNames(), ["send-gate-ticket-created", "send-gate-ticket-created"]);

  const gateLineMessage = state.lineMessages[0] as {
    data?: { to?: string; messages?: Array<{ type?: string; contents?: unknown }> };
  };
  const gateFlexContents = JSON.stringify(gateLineMessage.data?.messages?.[0]?.contents);

  assert.equal(gateLineMessage.data?.to, "line-vendor-stall-001");
  assert.match(gateFlexContents, new RegExp(expectedTicketNo));
  assert.match(gateFlexContents, /ABC-001/);
  assert.match(gateFlexContents, /Rambutan/);
});

test("POST /api/gate/tickets creates several markets in one request with WorkerCount = MAX per ticket + SUM per vehicle", async () => {
  const body = buildBoothJobJobBody("MULTI", {
    Markets: [
      buildTicket("004", {
        Booths: [
          { BoothCode: "STALL-004", Products: [product("02030103", "19", 100)] },
          {
            BoothCode: "STALL-004-B",
            Products: [product("02020300", "29", 180), product("02011701", "19", 80)],
          },
        ],
      }),
      buildTicket("005", {
        Booths: [{ BoothCode: "STALL-005", Products: [product("02030103", "19", 40)] }],
      }),
    ],
  });

  const response = await server.request("POST", "/api/gate/tickets", {
    body,
    headers: await gateAuthHeaders(),
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.Markets.length, 2);

  // ตลาดแรก MAX(2, 3, 2) = 3, ตลาดที่สอง MAX(1) = 1, รวมทั้งรถ 3 + 1 = 4
  assert.equal(response.body.Markets[0].TicketNo, toFourteenDigitId("TKT-20260723-004"));
  assert.equal(response.body.Markets[0].BoothCount, 2);
  assert.equal(response.body.Markets[0].WorkerCount, 3);
  assert.equal(response.body.Markets[1].TicketNo, toFourteenDigitId("TKT-20260723-005"));
  assert.equal(response.body.Markets[1].BoothCount, 1);
  assert.equal(response.body.Markets[1].WorkerCount, 1);
  assert.equal(response.body.WorkerCount, 4);

  assert.equal(state.ticketJobs.length, 1);
  assert.equal(state.ticketJobs[0].workers_required, 4);
  assert.equal(state.marketJobs.length, 2);
  assert.ok(state.marketJobs.every((market) => market.gate_no === "G01"));
  assert.equal(state.boothJobs.length, 3);
  assert.equal(state.ticketProducts.length, 4);

  // request เดียวสร้างหลายตั๋ว -> log เดียวไม่ผูกตั๋วใบใดใบหนึ่ง
  assert.equal(state.gateRequestLogs.length, 1);
  assert.equal(state.gateRequestLogs[0].market_job_id, null);

  // LINE แจ้งลงสินค้าครบทุกแผง (owner + member ต่อแผง)
  assert.equal(lineMessageNames().length, 6);
});

test("POST /api/gate/tickets does not dispatch queued workers when Dispatch is false", async () => {
  const worker = addWorker(9700);

  await workerQueue.enqueueWorker(worker.id);

  const response = await server.request("POST", "/api/gate/tickets", {
    body: buildBoothJobJobBody("006", { Dispatch: false }),
    headers: await gateAuthHeaders(),
  });
  const queueEntry = await workerQueue.getWorkerQueueStatus(worker.id);

  assert.equal(response.status, 201);
  assert.equal(response.body.Vehicle.Status, "waiting_unload");
  assert.equal(response.body.WorkerCount, 3);
  assert.equal(state.assignments.length, 0);
  assert.equal(queueEntry?.status, "ready");
});

test("POST /api/gate/tickets dispatches ready connected workers to the new Gate job once the queue has the full team", async () => {
  // งานนี้ต้องการ 3 คน (Rambutan 180) จึงเข้าคิวให้ครบ 3 คน
  const workers = [addWorker(9701), addWorker(9702), addWorker(9703)];
  const [worker] = workers;

  for (const queuedWorker of workers) {
    state.connectedWorkers.add(queuedWorker.id);
    await workerQueue.enqueueWorker(queuedWorker.id);
  }

  const response = await server.request("POST", "/api/gate/tickets", {
    body: buildBoothJobJobBody("007"),
    headers: await gateAuthHeaders(),
  });

  const queueEntry = await workerQueue.getWorkerQueueStatus(worker.id);

  assert.equal(response.status, 201);
  assert.equal(state.assignments.length, 3);
  assert.equal(state.assignments[0].vehicle_job_id, state.ticketJobs[0].id);
  assert.equal(state.assignments[0].worker_id, worker.id);
  assert.equal(queueEntry?.status, "assigned");
  assert.ok(
    state.socketEvents.some(
      (event) => event.workerId === worker.id && event.event === "WORKER_ASSIGNED"
    )
  );
});

test("POST /api/gate/tickets dispatch skips a READY worker who is outside their work shift and ejects them, moving on to the next FIFO worker", async () => {
  const outsideShiftWorker = addWorker(9691);
  const readyWorker = addWorker(9692);
  // งานนี้ต้องการ 3 คน จึงต้องมีคนในกะครบ 3 คนหลังข้ามคนนอกกะ
  const otherReadyWorkers = [addWorker(9693), addWorker(9694)];

  state.connectedWorkers.add(outsideShiftWorker.id);
  state.connectedWorkers.add(readyWorker.id);
  otherReadyWorkers.forEach((worker) => state.connectedWorkers.add(worker.id));

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

  for (const worker of otherReadyWorkers) {
    await workerQueue.enqueueWorker(worker.id);
  }

  const response = await server.request("POST", "/api/gate/tickets", {
    body: buildBoothJobJobBody("006"),
    headers: await gateAuthHeaders(),
  });

  assert.equal(response.status, 201);
  assert.deepEqual(
    state.assignments.map((assignment) => assignment.worker_id),
    [readyWorker.id, ...otherReadyWorkers.map((worker) => worker.id)]
  );
  assert.equal((await workerQueue.getWorkerQueueStatus(outsideShiftWorker.id))?.status, "open_app");
  assert.equal((await workerQueue.getWorkerQueueStatus(readyWorker.id))?.status, "assigned");
});

test("POST /api/gate/tickets dispatches exactly the required FIFO workers", async () => {
  const workers = Array.from({ length: 8 }, (_, index) => addWorker(9801 + index));

  for (const worker of workers) {
    await workerQueue.enqueueWorker(worker.id);
  }

  const response = await server.request("POST", "/api/gate/tickets", {
    body: buildBoothJobJobBody("004", {
      Markets: [
        buildTicket("004", {
          Booths: [
            { BoothCode: "STALL-004", Products: [product("02020300", "29", 180)] },
            {
              BoothCode: "STALL-004-B",
              Products: [product("02030103", "19", 100), product("02011701", "19", 80)],
            },
          ],
        }),
      ],
    }),
    headers: await gateAuthHeaders(),
  });

  // ใช้จำนวนคนสูงสุดของสินค้า: Rambutan 180 = 3, Cherry 100 = 2, Melon 80 = 2 จึงได้ 3
  assert.equal(response.status, 201);
  assert.equal(response.body.WorkerCount, 3);
  assert.equal(state.ticketJobs[0].workers_required, 3);
  assert.deepEqual(
    state.assignments.map((assignment) => assignment.worker_id),
    workers.slice(0, 3).map((worker) => worker.id)
  );
  assert.equal((await workerQueue.getWorkerQueueStatus(workers[3].id))?.status, "ready");
});

test("POST /api/gate/tickets replays the same Gate request", async () => {
  const body = buildBoothJobJobBody("002");
  const headers = await gateAuthHeaders();

  const created = await server.request("POST", "/api/gate/tickets", { body, headers });
  const replayed = await server.request("POST", "/api/gate/tickets", { body, headers });

  assert.equal(created.status, 201);
  assert.equal(replayed.status, 200);
  assert.equal(replayed.body.Result, "REPLAYED");
  assert.equal(replayed.body.GateNo, "G01");
  assert.equal(replayed.body.Vehicle.Status, "unload_now");
  assert.equal(replayed.body.Markets[0].TicketNo, toFourteenDigitId("TKT-20260723-002"));
  assert.equal(replayed.body.Markets[0].MarketCode, "MARKET-002");
  assert.equal(replayed.body.Markets[0].Booths[0].BoothCode, "STALL-002");
  assert.equal(replayed.body.WorkerCount, 3);
  assert.equal(state.ticketJobs.length, 1);
});

test("POST /api/gate/tickets replays a concurrent duplicate whose pre-check ran before the first request committed", async () => {
  const body = buildBoothJobJobBody("010");
  const headers = await gateAuthHeaders();
  const created = await server.request("POST", "/api/gate/tickets", { body, headers });
  const originalFind = gateRepositoryMock.findGateRequestReplayByRef;
  let calls = 0;

  // จำลอง request ที่ 2 ตรวจ gate_transaction_ref ก่อน request แรก commit (ยังไม่เห็น) แต่เข้า transaction หลัง commit แล้ว
  gateRepositoryMock.findGateRequestReplayByRef = async (gateTransactionRef: string) => {
    calls += 1;
    return calls === 1 ? null : originalFind(gateTransactionRef);
  };

  try {
    const duplicate = await server.request("POST", "/api/gate/tickets", { body, headers });

    assert.equal(created.status, 201);
    assert.equal(duplicate.status, 200, JSON.stringify(duplicate.body));
    assert.equal(duplicate.body.Result, "REPLAYED");
    assert.equal(state.ticketJobs.length, 1);
    assert.equal(state.marketJobs.length, 1);
  } finally {
    gateRepositoryMock.findGateRequestReplayByRef = originalFind;
  }
});

test("POST /api/gate/tickets rejects a TicketNo that is still active under the same TicketNumber and points to PUT", async () => {
  const headers = await gateAuthHeaders();
  const body = buildBoothJobJobBody("003");

  await server.request("POST", "/api/gate/tickets", { body, headers });

  const duplicate = await server.request("POST", "/api/gate/tickets", {
    body: { ...body, LicensePlate: "DIFFERENT-003" },
    headers,
  });

  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.code, "GATE_TICKET_ALREADY_EXISTS");
  assert.equal(state.marketJobs.length, 1);
});

test("POST /api/gate/tickets rejects duplicate BoothCode in the same ticket", async () => {
  const response = await server.request("POST", "/api/gate/tickets", {
    body: buildBoothJobJobBody("010", {
      Markets: [
        buildTicket("010", {
          Booths: [
            { BoothCode: "STALL-010", Products: [product("02020300", "29", 180)] },
            { BoothCode: "STALL-010", Products: [product("02020300", "29", 100)] },
          ],
        }),
      ],
    }),
    headers: await gateAuthHeaders(),
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.code, "VALIDATION_ERROR");
});

test("POST /api/gate/tickets rejects duplicate TicketNo in the same request", async () => {
  const response = await server.request("POST", "/api/gate/tickets", {
    body: buildBoothJobJobBody("011", {
      Markets: [buildTicket("011"), buildTicket("011")],
    }),
    headers: await gateAuthHeaders(),
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.code, "VALIDATION_ERROR");
});

test("POST /api/gate/tickets rejects a request missing GateNo", async () => {
  const { GateNo: _omitted, ...body } = buildBoothJobJobBody("012");

  const response = await server.request("POST", "/api/gate/tickets", {
    body,
    headers: await gateAuthHeaders(),
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.code, "VALIDATION_ERROR");
});

test("POST /api/gate/tickets rolls back every market when one market fails master validation", async () => {
  const response = await server.request("POST", "/api/gate/tickets", {
    body: buildBoothJobJobBody("013", {
      Markets: [
        buildTicket("013"),
        buildTicket("099", { MarketCode: "MARKET-UNKNOWN" }),
      ],
    }),
    headers: await gateAuthHeaders(),
  });

  assert.equal(response.status, 409);
  assert.equal(response.body.code, "MARKET_BOOTH_NOT_FOUND");
  assert.equal(state.ticketJobs.length, 0);
  assert.equal(state.marketJobs.length, 0);
});

test("POST /api/gate/tickets adds a new ticket to an existing TicketNumber and aggregates WorkerCount by SUM", async () => {
  const headers = await gateAuthHeaders();
  const ticketNumber = toFourteenDigitId("TRUCK-MULTI-001");

  const first = await server.request("POST", "/api/gate/tickets", {
    body: buildBoothJobJobBody("010", { TicketNumber: ticketNumber }),
    headers,
  });

  assert.equal(first.status, 201);
  assert.equal(first.body.WorkerCount, 3);

  const second = await server.request("POST", "/api/gate/tickets", {
    body: buildBoothJobJobBody("011", {
      TicketNumber: ticketNumber,
      Markets: [
        buildTicket("011", {
          Booths: [{ BoothCode: "STALL-011", Products: [product("02030103", "19", 100)] }],
        }),
      ],
    }),
    headers,
  });

  assert.equal(second.status, 201);
  assert.equal(state.ticketJobs.length, 1);
  assert.equal(state.marketJobs.length, 2);
  assert.equal(second.body.Markets.length, 1);
  assert.equal(second.body.Markets[0].WorkerCount, 2);
  // WorkerCount ระดับรถเป็นยอดรวมสะสมของทั้ง TicketNumber
  assert.equal(second.body.WorkerCount, 5);
  assert.equal(state.ticketJobs[0].workers_required, 5);
});

test("POST /api/gate/tickets never reuses a TicketNo cancelled by an Admin, and GET/PUT report the ticket as cancelled", async () => {
  const headers = await gateAuthHeaders();
  const { token: adminToken } = await loginJobAdmin(9701);
  const ticketNumber = toFourteenDigitId("TRUCK-CANCEL-REUSE-001");
  const ticketNo = toFourteenDigitId("TKT-CANCEL-REUSE-001");
  const body = buildBoothJobJobBody("007", {
    TicketNumber: ticketNumber,
    Markets: [buildTicket("007", { TicketNo: ticketNo })],
  });

  const first = await server.request("POST", "/api/gate/tickets", { body, headers });

  assert.equal(first.status, 201);

  const cancelResponse = await server.request(
    "POST",
    "/api/admin/vehicle-jobs/assignment/cancel",
    { token: adminToken, body: { ticket_number: ticketNumber, ticket_no: ticketNo, reason_code: "test", reason_text: "test reason" } },
  );

  assert.equal(cancelResponse.status, 200);
  assert.equal(state.marketJobs[0].status, "CANCELLED");

  const reused = await server.request("POST", "/api/gate/tickets", {
    body: { ...body, LicensePlate: "CANCEL-REUSE-001-NEW" },
    headers,
  });

  assert.equal(reused.status, 409, JSON.stringify(reused.body));
  assert.equal(reused.body.code, "TICKET_NO_ALREADY_EXISTS");
  assert.equal(reused.body.existingTicketNumber, ticketNumber);
  assert.equal(reused.body.existingStatus, "CANCELLED");
  assert.equal(state.marketJobs.filter((market) => market.ticket_no === ticketNo).length, 1);

  // นำเลขเดิมมาตรวจ ต้องรู้ทันทีว่าถูกยกเลิกแล้ว
  const lookup = await server.request("GET", `/api/gate/tickets/${ticketNo}`, { headers, external: true });

  assert.equal(lookup.status, 200, JSON.stringify(lookup.body));
  assert.equal(lookup.body.Market.Status, "CANCELLED");
  assert.equal(lookup.body.Market.MarketEditable, false);
  assert.equal(lookup.body.Market.Booths.length, 0);

  const edit = await server.request("PUT", `/api/gate/tickets/${ticketNo}`, {
    body: {
      GateNo: "G01",
      MarketCode: "MARKET-007",
      DropoffPoint: "Dropoff-007",
      Booths: [{ BoothCode: "STALL-007", Products: [product("02020300", "29", 180)] }],
    },
    headers,
  });

  assert.equal(edit.status, 409, JSON.stringify(edit.body));
  assert.equal(edit.body.code, "GATE_TICKET_CANCELLED");

  // ออกเลขใหม่ให้รถเดิมได้ และรถต้องเปิดกลับมาทำงาน ไม่งั้น dispatch ไม่หยิบรถคันนี้
  const newTicketNo = toFourteenDigitId("TKT-CANCEL-REUSE-002");
  const recreated = await server.request("POST", "/api/gate/tickets", {
    body: { ...body, Markets: [buildTicket("007", { TicketNo: newTicketNo })] },
    headers,
  });

  assert.equal(recreated.status, 201, JSON.stringify(recreated.body));
  assert.equal(recreated.body.Markets[0].TicketNo, newTicketNo);
  assert.equal(state.ticketJobs.find((job) => job.ticket_number === ticketNumber)!.status, "WORKING");
});

test("POST /api/gate/tickets rejects a TicketNo that equals any TicketNumber, and a TicketNumber that equals any TicketNo", async () => {
  const headers = await gateAuthHeaders();
  const created = await server.request("POST", "/api/gate/tickets", { body: buildBoothJobJobBody("008"), headers });

  assert.equal(created.status, 201);

  const existingTicketNumber = created.body.TicketNumber as string;
  const existingTicketNo = created.body.Markets[0].TicketNo as string;

  const sameAsOwnTicketNumber = await server.request("POST", "/api/gate/tickets", {
    body: buildBoothJobJobBody("009", {
      Markets: [buildTicket("009", { TicketNo: toFourteenDigitId("TRUCK-20260723-009") })],
    }),
    headers,
  });

  assert.equal(sameAsOwnTicketNumber.status, 400, JSON.stringify(sameAsOwnTicketNumber.body));

  const ticketNoUsedAsTicketNumber = await server.request("POST", "/api/gate/tickets", {
    body: buildBoothJobJobBody("009", {
      Markets: [buildTicket("009", { TicketNo: existingTicketNumber })],
    }),
    headers,
  });

  assert.equal(ticketNoUsedAsTicketNumber.status, 409, JSON.stringify(ticketNoUsedAsTicketNumber.body));
  assert.equal(ticketNoUsedAsTicketNumber.body.code, "TICKET_NO_CONFLICTS_WITH_TICKET_NUMBER");

  const ticketNumberUsedAsTicketNo = await server.request("POST", "/api/gate/tickets", {
    body: buildBoothJobJobBody("009", { TicketNumber: existingTicketNo }),
    headers,
  });

  assert.equal(ticketNumberUsedAsTicketNo.status, 409, JSON.stringify(ticketNumberUsedAsTicketNo.body));
  assert.equal(ticketNumberUsedAsTicketNo.body.code, "TICKET_NUMBER_CONFLICTS_WITH_TICKET_NO");
  assert.equal(state.marketJobs.length, 1);
});

test("POST /api/gate/tickets stores the DropoffPoint sent for each ticket", async () => {
  const response = await server.request("POST", "/api/gate/tickets", {
    body: buildBoothJobJobBody("005", {
      Markets: [buildTicket("005", { DropoffPoint: "Gate 3 - Zone B" })],
    }),
    headers: await gateAuthHeaders(),
  });

  assert.equal(response.status, 201);
  assert.equal(state.marketJobs[0].dropoff_point, "Gate 3 - Zone B");
});

test("POST /api/gate/tickets rejects a ticket missing DropoffPoint", async () => {
  const { DropoffPoint: _omitted, ...ticketWithoutDropoffPoint } = buildTicket("006");

  const response = await server.request("POST", "/api/gate/tickets", {
    body: buildBoothJobJobBody("006", { Markets: [ticketWithoutDropoffPoint] }),
    headers: await gateAuthHeaders(),
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.code, "VALIDATION_ERROR");
});

/* -------------------------------------- Gate Ticket Route Tests -------------------------------------- */

// Function สร้างตั๋ว MARKET-004 ที่มี 2 แผง (STALL-004 ใช้ 2 คน, STALL-004-B ใช้ 3 คน)
async function createTwoBoothTicket(
  headers: Record<string, string>,
  overrides: Record<string, unknown> = {}
) {
  const response = await server.request("POST", "/api/gate/tickets", {
    body: buildBoothJobJobBody("EDIT", {
      Markets: [
        buildTicket("004", {
          Booths: [
            { BoothCode: "STALL-004", Products: [product("02030103", "19", 100)] },
            { BoothCode: "STALL-004-B", Products: [product("02020300", "29", 180)] },
          ],
        }),
      ],
      ...overrides,
    }),
    headers,
  });

  assert.equal(response.status, 201);
  return response.body.Markets[0].TicketNo as string;
}

// Function จำลองว่าแผงถูกส่งยอดแล้ว (เปลี่ยนสถานะแผงและสร้าง submission ให้ตรงกับข้อมูลจริง)
function markBoothSubmitted(boothIndex: number, boothStatus: string, submissionStatus = boothStatus) {
  const booth = state.boothJobs[boothIndex];

  booth.status = boothStatus;
  state.completionSubmissions.push({
    id: state.nextSubmissionId++,
    ticket_id: booth.id,
    worker_count_snapshot: 1,
    status: submissionStatus,
    confirmed_at: null,
    rejected_at: null,
    resolved_by_line_user_id: null,
  });
}

test("POST /api/gate/tickets rejects a TicketNo already used by an active ticket of another vehicle", async () => {
  const headers = await gateAuthHeaders();
  const ticketNo = await createTwoBoothTicket(headers);

  const response = await server.request("POST", "/api/gate/tickets", {
    body: buildBoothJobJobBody("OTHER-VEHICLE", {
      Markets: [buildTicket("004", { TicketNo: ticketNo })],
    }),
    headers,
  });

  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.code, "TICKET_NO_ALREADY_EXISTS");
  assert.equal(response.body.ticket_no, ticketNo);
  // test client แปลง key กลับเป็น camelCase ส่วน Gate ได้ ExistingTicketNumber / ExistingMarketCode
  assert.equal(response.body.existingTicketNumber, toFourteenDigitId("TRUCK-20260723-EDIT"));
  assert.equal(response.body.existingMarketCode, "MARKET-004");

  // GET ยังหาตั๋วเดิมได้
  const lookup = await server.request("GET", `/api/gate/tickets/${ticketNo}`, { headers, external: true });

  assert.equal(lookup.status, 200, JSON.stringify(lookup.body));
});

test("GET /api/gate/tickets/:ticketNo returns the current ticket as editable before any booth is submitted", async () => {
  const headers = await gateAuthHeaders();
  const ticketNo = await createTwoBoothTicket(headers);

  const response = await server.request("GET", `/api/gate/tickets/${ticketNo}`, { headers, external: true });

  assert.equal(response.status, 200);
  assert.equal(response.body.TicketNumber, toFourteenDigitId("TRUCK-20260723-EDIT"));
  assert.equal(response.body.GateNo, "G01");
  assert.equal(response.body.Version, undefined);
  assert.equal(response.body.Market.TicketNo, ticketNo);
  assert.equal(response.body.Market.MarketCode, "MARKET-004");
  assert.equal(response.body.Market.WorkerCount, 3);
  assert.equal(response.body.Market.MarketEditable, true);
  assert.equal(response.body.Market.Booths.length, 2);
  assert.equal(response.body.Market.Booths[0].Editable, true);
  assert.equal(response.body.Market.Booths[0].LockReason, null);
  assert.equal(response.body.Market.Booths[1].Editable, true);
  assert.equal(response.body.Market.Booths[1].LockReason, null);
  assert.equal(response.body.Market.Booths[1].Products[0].WorkerCount, 3);
});

test("GET /api/gate/tickets/:ticketNo locks every booth with TICKET_ALREADY_SUBMITTED once any booth of the ticket was submitted", async () => {
  const headers = await gateAuthHeaders();
  const ticketNo = await createTwoBoothTicket(headers);
  markBoothSubmitted(0, "DELIVERED");

  const response = await server.request("GET", `/api/gate/tickets/${ticketNo}`, { headers, external: true });

  assert.equal(response.status, 200);
  assert.equal(response.body.Market.MarketEditable, false);
  assert.equal(response.body.Market.Booths[0].Status, "DELIVERED");
  for (const booth of response.body.Market.Booths) {
    assert.equal(booth.Editable, false);
    assert.equal(booth.LockReason, "TICKET_ALREADY_SUBMITTED");
  }
});

test("GET /api/gate/tickets/:ticketNo returns 404 for an unknown TicketNo and 400 for a malformed one", async () => {
  const headers = await gateAuthHeaders();

  const missing = await server.request("GET", `/api/gate/tickets/${toFourteenDigitId("UNKNOWN")}`, { headers });
  const malformed = await server.request("GET", "/api/gate/tickets/ABC", { headers });

  assert.equal(missing.status, 404);
  assert.equal(missing.body.code, "GATE_TICKET_NOT_FOUND");
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.code, "INVALID_TICKET_NO");
});

test("PUT /api/gate/tickets/:ticketNo updates a changed booth in place instead of cancelling and recreating it", async () => {
  const headers = await gateAuthHeaders();
  const ticketNo = await createTwoBoothTicket(headers);
  const [originalBooth004, originalBooth004B] = state.boothJobs;
  const originalProductId = state.ticketProducts.find(
    (product) => product.ticket_id === originalBooth004B.id
  )!.id;

  state.lineMessages.length = 0;

  const response = await server.request("PUT", `/api/gate/tickets/${ticketNo}`, {
    body: {
      GateNo: "G02",
      MarketCode: "MARKET-004",
      DropoffPoint: "Dropoff-004",
      Booths: [
        // สินค้าเดิม -> คงไว้
        { BoothCode: "STALL-004", Products: [product("02030103", "19", 100)] },
        // เปลี่ยนจำนวน -> แก้แถวเดิม
        { BoothCode: "STALL-004-B", Products: [product("02020300", "29", 40)] },
      ],
    },
    headers,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.Result, "UPDATED");
  assert.equal(response.body.GateNo, "G02");
  assert.deepEqual(response.body.Changes.Unchanged, ["STALL-004"]);
  assert.deepEqual(response.body.Changes.Updated, ["STALL-004-B"]);
  assert.deepEqual(response.body.Changes.Removed, []);
  assert.deepEqual(response.body.Changes.Added, []);
  // MAX(Cherry 100 = 2, Rambutan 40 = 1) = 2
  assert.equal(response.body.Changes.PreviousWorkerCount, 3);
  assert.equal(response.body.Changes.WorkerCount, 2);
  assert.equal(response.body.WorkerCount, 2);

  // BoothJob และสินค้าเป็นแถวเดิม ไม่มีแถว CANCELLED เพิ่ม
  assert.equal(state.boothJobs.length, 2);
  assert.ok(state.boothJobs.every((booth) => booth.status === "WAIT"));
  assert.equal(originalBooth004.status, "WAIT");
  assert.equal(originalBooth004B.status, "WAIT");

  const updatedProduct = state.ticketProducts.find((item) => item.id === originalProductId);

  assert.ok(updatedProduct);
  assert.equal(updatedProduct.ticket_id, originalBooth004B.id);
  assert.equal(updatedProduct.quantity, "40");
  assert.equal(updatedProduct.required_worker_count_snapshot, 1);
  assert.equal(state.marketJobs.length, 1);
  assert.equal(state.marketJobs[0].booth_count, 2);
  assert.equal(state.marketJobs[0].workers_required, 2);
  assert.equal(state.ticketJobs[0].workers_required, 2);
  // Gate ที่ออกตั๋วไม่เปลี่ยน ส่วน Gate ที่แก้อยู่ใน request log
  assert.equal(state.marketJobs[0].gate_no, "G01");

  // แก้ไขไม่ใช่การยกเลิก จึงไม่มี admin action log ยกเลิกแผง
  assert.equal(state.adminActionLogs.some((log) => log.action_type === "STALL_JOB_CANCELLED"), false);

  // เก็บประวัติก่อน/หลังพร้อม Gate ที่แก้
  const updateLog = state.gateRequestLogs.find((log) => log.request_type === "UPDATE");
  type RevisionBooth = { BoothJobId: string; BoothCode: string; Products: Array<{ Quantity: number }> };
  const beforeBooth = (updateLog?.before_snapshot as { Booths: RevisionBooth[] }).Booths.find(
    (booth) => booth.BoothCode === "STALL-004-B"
  );
  const afterBooth = (updateLog?.after_snapshot as { Booths: RevisionBooth[] }).Booths.find(
    (booth) => booth.BoothCode === "STALL-004-B"
  );

  assert.ok(updateLog);
  assert.equal(updateLog.gate_no, "G02");
  assert.deepEqual((updateLog.change_summary as { Updated: string[] }).Updated, ["STALL-004-B"]);
  assert.equal(beforeBooth?.Products[0].Quantity, 180);
  assert.equal(afterBooth?.Products[0].Quantity, 40);
  assert.equal(beforeBooth?.BoothJobId, String(originalBooth004B.id));
  assert.equal(afterBooth?.BoothJobId, String(originalBooth004B.id));

  // Vendor ของแผงที่แก้ได้ข้อความแก้ไขรายการ (ไม่ใช่ยกเลิก) แผงที่ไม่เปลี่ยนไม่ได้ข้อความ
  assert.deepEqual(lineMessageNames("line-vendor-stall-004-b"), ["send-gate-ticket-updated"]);
  assert.deepEqual(lineMessageNames("line-vendor-stall-004"), []);

  // Admin/Worker ได้ TICKET_JOB_UPDATED ครั้งเดียว ไม่มี event ยกเลิกแผง
  const realtimeTypes = state.realtimeEvents.map((event) => (event as { type?: string }).type);

  assert.equal(realtimeTypes.filter((type) => type === "TICKET_JOB_UPDATED").length, 1);
  assert.equal(realtimeTypes.includes("STALL_JOB_CANCELLED"), false);
  assert.equal(realtimeTypes.includes("MARKET_JOB_CANCELLED"), false);
});

test("PUT /api/gate/tickets/:ticketNo adds and removes products inside an existing booth without cancelling it", async () => {
  const headers = await gateAuthHeaders();
  const ticketNo = await createTwoBoothTicket(headers);
  const [booth004, booth004B] = state.boothJobs;
  const keptProductId = state.ticketProducts.find((item) => item.ticket_id === booth004B.id)!.id;
  const removedProductId = state.ticketProducts.find((item) => item.ticket_id === booth004.id)!.id;

  const response = await server.request("PUT", `/api/gate/tickets/${ticketNo}`, {
    body: {
      GateNo: "G01",
      MarketCode: "MARKET-004",
      DropoffPoint: "Dropoff-004",
      Booths: [
        // นำ Cherry ออก ใส่ Melon แทน
        { BoothCode: "STALL-004", Products: [product("02011701", "19", 80)] },
        // คง Rambutan และเพิ่ม Melon
        {
          BoothCode: "STALL-004-B",
          Products: [product("02020300", "29", 180), product("02011701", "19", 80)],
        },
      ],
    },
    headers,
  });

  assert.equal(response.status, 200);
  assert.deepEqual([...response.body.Changes.Updated].sort(), ["STALL-004", "STALL-004-B"]);
  assert.deepEqual(response.body.Changes.Removed, []);
  assert.deepEqual(response.body.Changes.Added, []);
  assert.equal(state.boothJobs.length, 2);
  assert.ok(state.boothJobs.every((booth) => booth.status === "WAIT"));
  assert.equal(state.ticketProducts.some((item) => item.id === removedProductId), false);
  assert.ok(state.ticketProducts.some((item) => item.id === keptProductId));
  assert.deepEqual(
    state.ticketProducts
      .filter((item) => item.ticket_id === booth004.id)
      .map((item) => item.productCode),
    ["02011701"]
  );
  assert.deepEqual(
    state.ticketProducts
      .filter((item) => item.ticket_id === booth004B.id)
      .map((item) => item.productCode)
      .sort(),
    ["02011701", "02020300"]
  );
  assert.equal(response.body.Markets[0].BoothCount, 2);
});

test("PUT /api/gate/tickets/:ticketNo keeps Admin booth exclusions because the edited booth keeps its id", async () => {
  const headers = await gateAuthHeaders();
  const ticketNo = await createTwoBoothTicket(headers);
  const marketJobId = state.marketJobs[0].id;
  const editedBooth = state.boothJobs[1];
  const now = new Date().toISOString();

  state.ticketWorkers.push(
    { id: 501, market_job_id: marketJobId, worker_id: 9001, status: "WORKING", joined_at: now, cancelled_at: null, completed_at: null },
  );
  state.boothJobWorkerExclusions.push(
    { id: 1, gate_ticket_id: editedBooth.id, ticket_worker_id: 501, cancelled_at: now },
  );
  state.nextBoothJobWorkerExclusionId = 2;

  const response = await server.request("PUT", `/api/gate/tickets/${ticketNo}`, {
    body: {
      GateNo: "G01",
      MarketCode: "MARKET-004",
      DropoffPoint: "Dropoff-004",
      Booths: [
        { BoothCode: "STALL-004", Products: [product("02030103", "19", 100)] },
        { BoothCode: "STALL-004-B", Products: [product("02020300", "29", 40)] },
      ],
    },
    headers,
  });

  assert.equal(response.status, 200);
  assert.equal(editedBooth.status, "WAIT");
  assert.deepEqual(
    state.boothJobWorkerExclusions.map((exclusion) => [exclusion.gate_ticket_id, exclusion.ticket_worker_id]),
    [[editedBooth.id, 501]]
  );
});

test("PUT /api/gate/tickets/:ticketNo removes a missing booth and adds a new booth", async () => {
  const headers = await gateAuthHeaders();
  const ticketNo = await createTwoBoothTicket(headers);
  const removedBooth = state.boothJobs[1];

  const response = await server.request("PUT", `/api/gate/tickets/${ticketNo}`, {
    body: {
      GateNo: "G01",
      MarketCode: "MARKET-004",
      DropoffPoint: "Dropoff-004",
      Booths: [{ BoothCode: "STALL-004", Products: [product("02030103", "19", 100)] }],
    },
    headers,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.Changes.Removed, ["STALL-004-B"]);
  assert.equal(removedBooth.status, "CANCELLED");
  assert.equal(state.marketJobs[0].booth_count, 1);
  assert.equal(state.marketJobs[0].workers_required, 2);
  assert.deepEqual(lineMessageNames("line-vendor-stall-004-b").slice(-1), ["send-gate-ticket-cancelled"]);

  const added = await server.request("PUT", `/api/gate/tickets/${ticketNo}`, {
    body: {
      GateNo: "G01",
      MarketCode: "MARKET-004",
      DropoffPoint: "Dropoff-004",
      Booths: [
        { BoothCode: "STALL-004", Products: [product("02030103", "19", 100)] },
        { BoothCode: "STALL-004-B", Products: [product("02011701", "19", 80)] },
      ],
    },
    headers,
  });

  assert.equal(added.status, 200);
  assert.deepEqual(added.body.Changes.Added, ["STALL-004-B"]);
  assert.deepEqual(lineMessageNames("line-vendor-stall-004-b").slice(-1), ["send-gate-ticket-created"]);
});

test("PUT /api/gate/tickets/:ticketNo returns NO_CHANGE without notifications when nothing changed", async () => {
  const headers = await gateAuthHeaders();
  const ticketNo = await createTwoBoothTicket(headers);

  state.lineMessages.length = 0;

  const response = await server.request("PUT", `/api/gate/tickets/${ticketNo}`, {
    body: {
      GateNo: "G01",
      MarketCode: "MARKET-004",
      DropoffPoint: "Dropoff-004",
      Booths: [
        { BoothCode: "STALL-004-B", Products: [product("02020300", "29", 180)] },
        { BoothCode: "STALL-004", Products: [product("02030103", "19", 100)] },
      ],
    },
    headers,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.Result, "NO_CHANGE");
  assert.deepEqual(response.body.Changes.Unchanged.sort(), ["STALL-004", "STALL-004-B"]);
  assert.equal(state.lineMessages.length, 0);
  assert.equal(
    state.realtimeEvents.some((event) => (event as { type?: string }).type === "TICKET_JOB_UPDATED"),
    false
  );
  assert.ok(state.boothJobs.every((booth) => booth.status === "WAIT"));
});

test("PUT /api/gate/tickets/:ticketNo rejects every edit with TICKET_ALREADY_SUBMITTED once any booth was submitted, even edits that only touch an unsubmitted booth", async () => {
  const headers = await gateAuthHeaders();
  const ticketNo = await createTwoBoothTicket(headers);

  markBoothSubmitted(1, "DELIVERED");
  const openBoothStatus = state.boothJobs[0].status;

  const otherBoothChanged = await server.request("PUT", `/api/gate/tickets/${ticketNo}`, {
    body: {
      GateNo: "G01",
      MarketCode: "MARKET-004",
      DropoffPoint: "Dropoff-004",
      Booths: [
        { BoothCode: "STALL-004", Products: [product("02030103", "19", 80)] },
        { BoothCode: "STALL-004-B", Products: [product("02020300", "29", 180)] },
      ],
    },
    headers,
  });

  assert.equal(otherBoothChanged.status, 409);
  assert.equal(otherBoothChanged.body.code, "TICKET_ALREADY_SUBMITTED");

  const changedMarket = await server.request("PUT", `/api/gate/tickets/${ticketNo}`, {
    body: {
      GateNo: "G01",
      MarketCode: "MARKET-005",
      DropoffPoint: "Dropoff-005",
      Booths: [{ BoothCode: "STALL-005", Products: [product("02030103", "19", 100)] }],
    },
    headers,
  });

  assert.equal(changedMarket.status, 409);
  assert.equal(changedMarket.body.code, "TICKET_ALREADY_SUBMITTED");

  // ไม่มีแผงไหนถูกแตะ และไม่มีแผงใหม่ถูกสร้าง
  assert.equal(state.boothJobs.length, 2);
  assert.equal(state.boothJobs[0].status, openBoothStatus);
  assert.equal(state.ticketProducts.find((item) => item.ticket_id === state.boothJobs[0].id)?.quantity, "100");
  assert.equal(state.boothJobs[1].status, "DELIVERED");
});

test("PUT /api/gate/tickets/:ticketNo stays locked after a submitted booth was rejected and then cancelled by an admin", async () => {
  const headers = await gateAuthHeaders();
  const ticketNo = await createTwoBoothTicket(headers);

  markBoothSubmitted(1, "CANCELLED", "REJECT");

  const response = await server.request("PUT", `/api/gate/tickets/${ticketNo}`, {
    body: {
      GateNo: "G01",
      MarketCode: "MARKET-004",
      DropoffPoint: "Dropoff-004",
      Booths: [{ BoothCode: "STALL-004", Products: [product("02030103", "19", 80)] }],
    },
    headers,
  });

  assert.equal(response.status, 409);
  assert.equal(response.body.code, "TICKET_ALREADY_SUBMITTED");
});

test("PUT /api/gate/tickets/:ticketNo still edits another TicketNo on the same vehicle that has no submitted booth", async () => {
  const headers = await gateAuthHeaders();
  const created = await server.request("POST", "/api/gate/tickets", {
    body: buildBoothJobJobBody("EDIT2", {
      Markets: [
        buildTicket("004", { Booths: [{ BoothCode: "STALL-004", Products: [product("02030103", "19", 100)] }] }),
        buildTicket("005", { Booths: [{ BoothCode: "STALL-005", Products: [product("02030103", "19", 100)] }] }),
      ],
    }),
    headers,
  });

  assert.equal(created.status, 201, JSON.stringify(created.body));
  const [submittedTicket, openTicket] = created.body.Markets as Array<{ TicketNo: string; MarketCode: string }>;
  const submittedBoothIndex = state.boothJobs.findIndex(
    (booth) => state.marketJobs.find((market) => market.id === booth.market_job_id)?.ticket_no === submittedTicket.TicketNo,
  );

  markBoothSubmitted(submittedBoothIndex, "DELIVERED");

  const response = await server.request("PUT", `/api/gate/tickets/${openTicket.TicketNo}`, {
    body: {
      GateNo: "G01",
      MarketCode: openTicket.MarketCode,
      DropoffPoint: "Dropoff-005",
      Booths: [{ BoothCode: "STALL-005", Products: [product("02030103", "19", 80)] }],
    },
    headers,
  });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(response.body.Result, "UPDATED");
});

test("PUT /api/gate/tickets/:ticketNo moves the ticket to another market by updating the same MarketJob and TicketNo", async () => {
  const headers = await gateAuthHeaders();
  const ticketNo = await createTwoBoothTicket(headers);
  const originalMarketJob = state.marketJobs[0];
  const [booth004, booth004B] = state.boothJobs;

  state.lineMessages.length = 0;

  const response = await server.request("PUT", `/api/gate/tickets/${ticketNo}`, {
    body: {
      GateNo: "G01",
      MarketCode: "MARKET-005",
      DropoffPoint: "Dropoff-005",
      Booths: [{ BoothCode: "STALL-005", Products: [product("02030103", "19", 40)] }],
    },
    headers,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.Changes.MarketChanged, true);
  assert.deepEqual(response.body.Changes.Removed, ["STALL-004", "STALL-004-B"]);
  assert.deepEqual(response.body.Changes.Added, ["STALL-005"]);
  assert.deepEqual(response.body.Changes.Updated, []);
  assert.equal(response.body.Markets[0].TicketNo, ticketNo);
  assert.equal(response.body.Markets[0].MarketCode, "MARKET-005");
  assert.equal(response.body.WorkerCount, 1);

  // MarketJob แถวเดิม ไม่มีตลาด CANCELLED เพิ่ม
  assert.equal(state.marketJobs.length, 1);
  assert.equal(originalMarketJob.status, "WORKING");
  assert.equal(originalMarketJob.ticket_no, ticketNo);
  assert.equal(originalMarketJob.marketCode, "MARKET-005");
  assert.equal(originalMarketJob.dropoff_point, "Dropoff-005");
  assert.equal(originalMarketJob.gate_no, "G01");
  assert.equal(state.adminActionLogs.some((log) => log.action_type === "MARKET_JOB_CANCELLED"), false);
  // แผงที่ไม่ได้ส่งมาถูกนำออกจริง จึงเป็น CANCELLED
  assert.equal(booth004.status, "CANCELLED");
  assert.equal(booth004B.status, "CANCELLED");
  assert.equal(
    state.adminActionLogs.filter((log) => log.action_type === "STALL_JOB_CANCELLED").length,
    2
  );
  assert.deepEqual(lineMessageNames("line-vendor-stall-004"), ["send-gate-ticket-cancelled"]);
  assert.deepEqual(lineMessageNames("line-vendor-stall-005"), ["send-gate-ticket-created"]);
});

test("PUT /api/gate/tickets/:ticketNo keeps a booth with the same BoothCode when moving market and re-notifies its vendor", async () => {
  const headers = await gateAuthHeaders();

  state.masterMarkets.push({
    id: 2001,
    marketCode: "MARKET-005",
    marketName: "Market B",
    boothCode: "STALL-004-B",
    boothName: "Vendor B2",
    marketStatus: "Normal",
    boothStatus: "Normal",
  });

  const ticketNo = await createTwoBoothTicket(headers);
  const keptBooth = state.boothJobs[1];

  state.lineMessages.length = 0;

  const response = await server.request("PUT", `/api/gate/tickets/${ticketNo}`, {
    body: {
      GateNo: "G01",
      MarketCode: "MARKET-005",
      DropoffPoint: "Dropoff-005",
      Booths: [{ BoothCode: "STALL-004-B", Products: [product("02020300", "29", 180)] }],
    },
    headers,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.Changes.Updated, ["STALL-004-B"]);
  assert.deepEqual(response.body.Changes.Removed, ["STALL-004"]);
  assert.equal(response.body.Markets[0].MarketName, "Market B");
  assert.equal(keptBooth.status, "WAIT");
  assert.equal(keptBooth.boothName, "Vendor B2");
  assert.equal(state.marketJobs.length, 1);
  // Vendor เปลี่ยนตามตลาด: แจ้งยกเลิกถึงตลาดเดิมก่อน แล้วแจ้งลงสินค้าถึงตลาดใหม่
  assert.deepEqual(lineMessageNames("line-vendor-stall-004-b"), [
    "send-gate-ticket-cancelled",
    "send-gate-ticket-created",
  ]);
});

test("PUT /api/gate/tickets/:ticketNo rejects removing every booth or product with 409 so Gate cannot cancel the ticket", async () => {
  const headers = await gateAuthHeaders();
  const ticketNo = await createTwoBoothTicket(headers);

  state.lineMessages.length = 0;

  const noBooths = await server.request("PUT", `/api/gate/tickets/${ticketNo}`, {
    body: {
      GateNo: "G01",
      MarketCode: "MARKET-004",
      DropoffPoint: "Dropoff-004",
      Booths: [],
    },
    headers,
  });
  const emptyProducts = await server.request("PUT", `/api/gate/tickets/${ticketNo}`, {
    body: {
      GateNo: "G01",
      MarketCode: "MARKET-004",
      DropoffPoint: "Dropoff-004",
      Booths: [
        { BoothCode: "STALL-004", Products: [product("02030103", "19", 100)] },
        { BoothCode: "STALL-004-B", Products: [] },
      ],
    },
    headers,
  });

  assert.equal(noBooths.status, 409);
  assert.equal(noBooths.body.code, "GATE_TICKET_MINIMUM_BOOTH_REQUIRED");
  assert.equal(emptyProducts.status, 409);
  assert.equal(emptyProducts.body.code, "GATE_TICKET_MINIMUM_BOOTH_REQUIRED");
  assert.deepEqual(emptyProducts.body.boothCodes, ["STALL-004-B"]);

  // ตั๋วและแผงไม่ถูกแตะ ไม่มี log แก้ไข และไม่มีการแจ้งเตือน
  assert.equal(state.marketJobs[0].status, "WORKING");
  assert.ok(state.boothJobs.every((booth) => booth.status === "WAIT"));
  assert.equal(state.gateRequestLogs.some((log) => log.request_type === "UPDATE"), false);
  assert.equal(state.lineMessages.length, 0);
});

test("POST /api/gate/tickets adding a ticket to an existing vehicle sends TICKET_JOB_UPDATED (TICKET_ADDED) to Admin and the workers on the vehicle instead of VEHICLE_JOB_CREATED", async () => {
  const headers = await gateAuthHeaders();
  const workers = Array.from({ length: 3 }, (_, index) => addWorker(9921 + index));

  for (const worker of workers) {
    state.connectedWorkers.add(worker.id);
    await workerQueue.enqueueWorker(worker.id);
  }

  await createTwoBoothTicket(headers);

  const workerIdsOnVehicle = state.assignments.map((assignment) => assignment.worker_id);

  assert.equal(workerIdsOnVehicle.length, 3);
  state.notifications.length = 0;
  state.realtimeEvents.length = 0;

  const added = await server.request("POST", "/api/gate/tickets", {
    body: buildBoothJobJobBody("EDIT", { Markets: [buildTicket("005")] }),
    headers,
  });

  assert.equal(added.status, 201);

  const addedMarket = state.marketJobs.find((market) => market.ticket_no === added.body.Markets[0].TicketNo)!;
  const updatedEvents = state.realtimeEvents.filter(
    (event) => (event as { type?: string }).type === "TICKET_JOB_UPDATED"
  ) as Array<{ admin?: boolean; worker_ids?: number[]; payload?: Record<string, unknown> }>;

  assert.equal(updatedEvents.length, 1);
  assert.equal(updatedEvents[0].admin, true);
  assert.deepEqual([...(updatedEvents[0].worker_ids ?? [])].sort(), [...workerIdsOnVehicle].sort());
  assert.equal(updatedEvents[0].payload?.changeType, "TICKET_ADDED");
  assert.equal(updatedEvents[0].payload?.ticketNo, added.body.Markets[0].TicketNo);
  assert.equal(updatedEvents[0].payload?.marketJobId, String(addedMarket.id));
  assert.deepEqual(updatedEvents[0].payload?.addedBoothCodes, ["STALL-005"]);
  assert.equal(updatedEvents[0].payload?.workersRequired, added.body.WorkerCount);
  assert.equal(
    state.notifications.some((event) => (event as { type?: string }).type === "VEHICLE_JOB_CREATED"),
    false
  );
});

test("POST /api/gate/tickets for a new vehicle still sends VEHICLE_JOB_CREATED and no TICKET_JOB_UPDATED", async () => {
  const response = await server.request("POST", "/api/gate/tickets", {
    body: buildBoothJobJobBody("011"),
    headers: await gateAuthHeaders(),
  });

  assert.equal(response.status, 201);
  assert.ok(state.notifications.some((event) => (event as { type?: string }).type === "VEHICLE_JOB_CREATED"));
  assert.equal(
    state.realtimeEvents.some((event) => (event as { type?: string }).type === "TICKET_JOB_UPDATED"),
    false
  );
});

test("PUT /api/gate/tickets/:ticketNo rejects re-adding a booth an admin cancelled, with who/when/why", async () => {
  const headers = await gateAuthHeaders();
  const ticketNo = await createTwoBoothTicket(headers);
  const admin = addAdmin(980200, "unused-hash");
  const booth = state.boothJobs.find((item) => item.boothCode === "STALL-004-B");

  assert.ok(booth);
  // Admin ยกเลิกแผงหลังจาก Gate โหลดตั๋วไปแล้ว
  booth.status = "CANCELLED";
  state.adminActionLogs.push({
    id: state.nextAdminActionLogId++,
    vehicle_job_id: booth.vehicle_job_id,
    gate_ticket_id: booth.id,
    market_job_id: booth.market_job_id,
    action_type: "STALL_JOB_CANCELLED",
    reason_code: "VENDOR_CLOSED",
    reason_text: "Vendor closed today",
    actor_account_id: admin.id,
    actor_gate_client_id: null,
    metadata: null,
    created_at: "2026-10-16T08:00:00.000Z",
  });

  const response = await server.request("PUT", `/api/gate/tickets/${ticketNo}`, {
    body: {
      GateNo: "G01",
      MarketCode: "MARKET-004",
      DropoffPoint: "Dropoff-004",
      Booths: [
        { BoothCode: "STALL-004", Products: [product("02030103", "19", 100)] },
        { BoothCode: "STALL-004-B", Products: [product("02020300", "29", 50)] },
      ],
    },
    headers,
  });

  assert.equal(response.status, 409, JSON.stringify(response.body));
  assert.equal(response.body.code, "BOOTH_CANCELLED_BY_ADMIN");
  assert.deepEqual(response.body.booths, [{
    boothCode: "STALL-004-B",
    cancelled_at: "2026-10-16T08:00:00.000Z",
    cancelled_by_name: admin.full_name,
    reason_code: "VENDOR_CLOSED",
    reason_text: "Vendor closed today",
  }]);
  assert.equal(state.boothJobs.filter((item) => item.boothCode === "STALL-004-B").length, 1);

  // ไม่ส่งแผงที่ Admin ยกเลิกมา แก้แผงที่เหลือได้ตามปกติ
  const withoutCancelled = await server.request("PUT", `/api/gate/tickets/${ticketNo}`, {
    body: {
      GateNo: "G01",
      MarketCode: "MARKET-004",
      DropoffPoint: "Dropoff-004",
      Booths: [{ BoothCode: "STALL-004", Products: [product("02030103", "19", 90)] }],
    },
    headers,
  });

  assert.equal(withoutCancelled.status, 200, JSON.stringify(withoutCancelled.body));
});
test("PUT /api/gate/tickets/:ticketNo cancels the newest unscanned assignments when fewer workers are needed and notifies every worker on the vehicle", async () => {
  const headers = await gateAuthHeaders();
  const workers = Array.from({ length: 3 }, (_, index) => addWorker(9901 + index));

  for (const worker of workers) {
    state.connectedWorkers.add(worker.id);
    await workerQueue.enqueueWorker(worker.id);
  }

  const ticketNo = await createTwoBoothTicket(headers);

  assert.equal(state.assignments.length, 3);

  const response = await server.request("PUT", `/api/gate/tickets/${ticketNo}`, {
    body: {
      GateNo: "G01",
      MarketCode: "MARKET-004",
      DropoffPoint: "Dropoff-004",
      Booths: [
        { BoothCode: "STALL-004", Products: [product("02030103", "19", 100)] },
        { BoothCode: "STALL-004-B", Products: [product("02020300", "29", 40)] },
      ],
    },
    headers,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.WorkerCount, 2);

  // คนที่ได้งานล่าสุดถูกยกเลิกและกลับหน้าคิว คนที่เหลือยังอยู่
  const newestAssignment = [...state.assignments].sort((left, right) => right.id - left.id)[0];

  assert.equal(newestAssignment.status, "CANCELLED");
  assert.equal(state.assignments.filter((assignment) => assignment.status !== "CANCELLED").length, 2);
  assert.equal((await workerQueue.getWorkerQueueStatus(newestAssignment.worker_id))?.status, "ready");
  assert.ok(
    state.socketEvents.some(
      (event) => event.workerId === newestAssignment.worker_id && event.event === "ASSIGNMENT_CANCELLED"
    )
  );

  // Admin ได้ WORKER_STATUS_CHANGED ของคนที่ถูกตัด เพื่อให้ Worker Board อัปเดต
  const workerStatusEvent = state.notifications.find(
    (event) =>
      (event as { type?: string }).type === "WORKER_STATUS_CHANGED" &&
      (event as { payload?: { reason?: string } }).payload?.reason === "gate_ticket_update_requeue"
  ) as { payload?: { queue?: { status?: string } } } | undefined;

  assert.ok(workerStatusEvent, "Admin must receive WORKER_STATUS_CHANGED for the removed worker");
  assert.equal(workerStatusEvent.payload?.queue?.status, "ready");

  // Worker ที่ยังอยู่บนรถทุกคน (ไม่รวมคนที่ถูกยกเลิก) และ Admin ได้ TICKET_JOB_UPDATED
  const remainingWorkerIds = state.assignments
    .filter((assignment) => assignment.status !== "CANCELLED")
    .map((assignment) => assignment.worker_id);
  const updatedEvent = state.realtimeEvents.find(
    (event) => (event as { type?: string }).type === "TICKET_JOB_UPDATED"
  ) as { admin?: boolean; worker_ids?: number[]; worker_payload?: Record<string, unknown> } | undefined;

  assert.ok(updatedEvent);
  assert.equal(updatedEvent.admin, true);
  assert.deepEqual([...(updatedEvent.worker_ids ?? [])].sort(), [...remainingWorkerIds].sort());
  assert.equal(updatedEvent.worker_payload?.ticketNo, ticketNo);
  assert.deepEqual(updatedEvent.worker_payload?.updatedBoothCodes, ["STALL-004-B"]);
  assert.equal(updatedEvent.worker_payload?.marketJobId, String(state.marketJobs[0].id));

  for (const workerId of remainingWorkerIds) {
    assert.ok(
      updatedEvent.worker_ids?.includes(workerId),
      `worker ${workerId} must receive TICKET_JOB_UPDATED`
    );
  }
});

test("PUT /api/gate/tickets/:ticketNo dispatches more workers when the edit needs more people", async () => {
  const headers = await gateAuthHeaders();
  const workers = Array.from({ length: 4 }, (_, index) => addWorker(9951 + index));

  for (const worker of workers) {
    state.connectedWorkers.add(worker.id);
    await workerQueue.enqueueWorker(worker.id);
  }

  const ticketNo = await createTwoBoothTicket(headers);

  assert.equal(state.assignments.length, 3);

  const response = await server.request("PUT", `/api/gate/tickets/${ticketNo}`, {
    body: {
      GateNo: "G01",
      MarketCode: "MARKET-004",
      DropoffPoint: "Dropoff-004",
      Booths: [
        { BoothCode: "STALL-004", Products: [product("02030103", "19", 100)] },
        // Rambutan 250 ใช้ 4 คน
        { BoothCode: "STALL-004-B", Products: [product("02020300", "29", 250)] },
      ],
    },
    headers,
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.WorkerCount, 4);
  assert.equal(state.assignments.filter((assignment) => assignment.status !== "CANCELLED").length, 4);
});

test("PUT /api/gate/tickets/:ticketNo after the team started does not dispatch the extra workers; the slots wait for the admin and the team can still submit", async () => {
  const headers = await gateAuthHeaders();
  const workers = Array.from({ length: 4 }, (_, index) => addWorker(9961 + index));

  for (const worker of workers) {
    state.connectedWorkers.add(worker.id);
    await workerQueue.enqueueWorker(worker.id);
  }

  const ticketNo = await createTwoBoothTicket(headers);
  const job = state.ticketJobs[0];

  // ทีม 3 คน scan ครบและเริ่มงานแล้ว
  for (const assignment of state.assignments) {
    assignment.status = "SCANNED";
    assignment.scanned_at = new Date().toISOString();
  }
  job.work_started_at = new Date().toISOString();

  const increased = await server.request("PUT", `/api/gate/tickets/${ticketNo}`, {
    body: {
      GateNo: "G01",
      MarketCode: "MARKET-004",
      DropoffPoint: "Dropoff-004",
      Booths: [
        { BoothCode: "STALL-004", Products: [product("02030103", "19", 100)] },
        // Rambutan 250 ใช้ 4 คน
        { BoothCode: "STALL-004-B", Products: [product("02020300", "29", 250)] },
      ],
    },
    headers,
  });

  assert.equal(increased.status, 200, JSON.stringify(increased.body));
  assert.equal(increased.body.WorkerCount, 4);
  assert.equal(job.unfilled_slot_count, 1);
  // ไม่มีการเรียกคนเพิ่มอัตโนมัติ คนที่ 4 ยังอยู่ในคิว
  assert.equal(state.assignments.length, 3);
  assert.equal((await workerQueue.getWorkerQueueStatus(workers[3].id))?.status, "ready");

  // ลดกลับเป็น 3 คน = ใช้ช่องที่ยังไม่ได้เติมก่อน ไม่ตัดใครออก
  const decreased = await server.request("PUT", `/api/gate/tickets/${ticketNo}`, {
    body: {
      GateNo: "G01",
      MarketCode: "MARKET-004",
      DropoffPoint: "Dropoff-004",
      Booths: [
        { BoothCode: "STALL-004", Products: [product("02030103", "19", 100)] },
        { BoothCode: "STALL-004-B", Products: [product("02020300", "29", 180)] },
      ],
    },
    headers,
  });

  assert.equal(decreased.status, 200, JSON.stringify(decreased.body));
  assert.equal(decreased.body.WorkerCount, 3);
  assert.equal(job.unfilled_slot_count, 0);
  assert.equal(state.assignments.filter((assignment) => assignment.status === "CANCELLED").length, 0);
});

/* -------------------------------------- Gate Ticket Update Work History Route Tests -------------------------------------- */

// Type รายการ Timeline ใน Work History ที่ใช้ตรวจใน test (ActorCode ไม่อยู่ใน request key map จึงกลับมาเป็น actorCode)
type HistoryTimelineEntry = {
  type: string;
  occurred_at: string;
  actor_type: string;
  actorCode: string | null;
  actor_name: string | null;
  description: string;
};

// Function ดึง Work History ของงานรถคันแรกด้วย Admin
async function requestFirstWorkHistory(adminToken: string) {
  const response = await server.request("GET", "/api/admin/vehicle-jobs/history", { token: adminToken });

  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data[0] as {
    vehicle_job: { history_flags: string[] };
    timeline: HistoryTimelineEntry[];
    markets: Array<{ booths: Array<{ boothCode: string; cancellation: Record<string, unknown> | null }> }>;
  };
}

// Function ยิง PUT แก้ตั๋วของ Gate (ค่าเริ่มต้น GateNo G02)
function putGateTicket(
  ticketNo: string,
  headers: Record<string, string>,
  body: Record<string, unknown>
) {
  return server.request("PUT", `/api/gate/tickets/${ticketNo}`, { body: { GateNo: "G02", ...body }, headers });
}

test("GET /api/admin/vehicle-jobs/history Timeline shows one GATE_TICKET_UPDATED per successful Gate edit (quantity, remove/add booth, dropoff) in time order and skips NO_CHANGE and failed requests", async () => {
  const headers = await gateAuthHeaders();
  const ticketNo = await createTwoBoothTicket(headers);
  const { token: adminToken } = await loginJobAdmin(980100);
  const booths = (stall004BQuantity: number) => [
    { BoothCode: "STALL-004", Products: [product("02030103", "19", 100)] },
    { BoothCode: "STALL-004-B", Products: [product("02020300", "29", stall004BQuantity)] },
  ];

  const quantityOnly = await putGateTicket(ticketNo, headers, {
    MarketCode: "MARKET-004",
    DropoffPoint: "Dropoff-004",
    Booths: booths(40),
  });
  const removeBooth = await putGateTicket(ticketNo, headers, {
    MarketCode: "MARKET-004",
    DropoffPoint: "Dropoff-004",
    Booths: [{ BoothCode: "STALL-004", Products: [product("02030103", "19", 100)] }],
  });
  const addBooth = await putGateTicket(ticketNo, headers, {
    MarketCode: "MARKET-004",
    DropoffPoint: "Dropoff-004",
    Booths: booths(60),
  });
  const dropoffOnly = await putGateTicket(ticketNo, headers, {
    MarketCode: "MARKET-004",
    DropoffPoint: "Dropoff-004-NEW",
    Booths: booths(60),
  });
  const noChange = await putGateTicket(ticketNo, headers, {
    MarketCode: "MARKET-004",
    DropoffPoint: "Dropoff-004-NEW",
    Booths: booths(60),
  });
  const emptyBooths = await putGateTicket(ticketNo, headers, {
    MarketCode: "MARKET-004",
    DropoffPoint: "Dropoff-004",
    Booths: [],
  });

  assert.equal(quantityOnly.body.Result, "UPDATED", JSON.stringify(quantityOnly.body));
  assert.deepEqual(removeBooth.body.Changes.Removed, ["STALL-004-B"]);
  assert.deepEqual(addBooth.body.Changes.Added, ["STALL-004-B"]);
  assert.equal(dropoffOnly.body.Changes.DropoffPointChanged, true);
  assert.equal(noChange.body.Result, "NO_CHANGE");
  assert.equal(emptyBooths.status, 409);

  // NO_CHANGE ยังเก็บ log ไว้ให้ Audit แต่มี Result ชัดเจน
  assert.deepEqual(
    state.gateRequestLogs.filter((log) => log.request_type === "UPDATE").map((log) => log.result),
    ["UPDATED", "UPDATED", "UPDATED", "UPDATED", "NO_CHANGE"]
  );

  const history = await requestFirstWorkHistory(adminToken);
  const gateUpdates = history.timeline.filter((entry) => entry.type === "GATE_TICKET_UPDATED");
  const updateLogs = state.gateRequestLogs.filter((log) => log.result === "UPDATED");

  assert.equal(gateUpdates.length, 4, JSON.stringify(history.timeline));
  assert.deepEqual(gateUpdates.map((entry) => entry.occurred_at), updateLogs.map((log) => log.created_at));
  // Gate แก้ตั๋ว (รวมนำแผงออก) ดูได้จาก Timeline เท่านั้น ไม่เพิ่ม HistoryFlag
  assert.ok(!history.vehicle_job.history_flags.includes("WORKER_CHANGED_DURING_JOB"));

  for (const entry of gateUpdates) {
    assert.equal(entry.actor_type, "gate");
    assert.equal(entry.actorCode, "G02");
    assert.equal(entry.actor_name, "Gate gate-test");
    assert.equal(entry.description, `Gate G02 updated ticket ${ticketNo}.`);
  }

  // Gate ลบแผงไม่ถูกนับเป็น Admin action และเหตุการณ์เดิมยังอยู่ครบ
  assert.equal(history.timeline.some((entry) => entry.type === "ADMIN_ACTION"), false);
  assert.ok(history.timeline.some((entry) => entry.type === "GATE_ARRIVAL"));

  const occurredAts = history.timeline.map((entry) => entry.occurred_at);

  assert.deepEqual(occurredAts, [...occurredAts].sort());
});

test("GET /api/admin/vehicle-jobs/history shows a single Gate update for a PUT that cancels several booths, with Gate as the cancellation actor", async () => {
  const headers = await gateAuthHeaders();
  const ticketNo = await createTwoBoothTicket(headers);
  const { token: adminToken } = await loginJobAdmin(980200);

  const response = await putGateTicket(ticketNo, headers, {
    MarketCode: "MARKET-005",
    DropoffPoint: "Dropoff-005",
    Booths: [{ BoothCode: "STALL-005", Products: [product("02030103", "19", 40)] }],
  });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body.Changes.Removed, ["STALL-004", "STALL-004-B"]);
  assert.equal(state.adminActionLogs.filter((log) => log.reason_code === "GATE_TICKET_UPDATED").length, 2);

  const history = await requestFirstWorkHistory(adminToken);
  const gateUpdates = history.timeline.filter((entry) => entry.type === "GATE_TICKET_UPDATED");

  assert.equal(gateUpdates.length, 1, JSON.stringify(history.timeline));
  assert.equal(history.timeline.some((entry) => entry.type === "ADMIN_ACTION"), false);

  const cancelledBooths = history.markets
    .flatMap((market) => market.booths)
    .filter((booth) => booth.cancellation !== null);

  assert.deepEqual(cancelledBooths.map((booth) => booth.boothCode).sort(), ["STALL-004", "STALL-004-B"]);

  for (const booth of cancelledBooths) {
    assert.equal(booth.cancellation?.cancelled_by_type, "gate");
    assert.equal(booth.cancellation?.cancelled_by_name, "Gate gate-test");
    assert.equal(booth.cancellation?.reason_code, "GATE_TICKET_UPDATED");
  }
});

test("GET /api/admin/vehicle-jobs/history falls back to Gate {GateNo} when the Gate client is unknown and fills ActorCode on existing event types", async () => {
  const headers = await gateAuthHeaders();
  const ticketNo = await createTwoBoothTicket(headers);
  const { token: adminToken } = await loginJobAdmin(980300);

  await putGateTicket(ticketNo, headers, {
    GateNo: "G09",
    MarketCode: "MARKET-004",
    DropoffPoint: "Dropoff-004",
    Booths: [{ BoothCode: "STALL-004", Products: [product("02030103", "19", 100)] }],
  });

  // จำลอง log ที่ไม่มี Gate client
  for (const log of state.gateRequestLogs) {
    log.gate_client_id = null;
  }

  for (const log of state.adminActionLogs) {
    log.actor_gate_client_id = null;
  }

  const history = await requestFirstWorkHistory(adminToken);
  const gateUpdate = history.timeline.find((entry) => entry.type === "GATE_TICKET_UPDATED");
  const cancelledBooth = history.markets
    .flatMap((market) => market.booths)
    .find((booth) => booth.boothCode === "STALL-004-B");
  const arrival = history.timeline.find((entry) => entry.type === "GATE_ARRIVAL");

  assert.equal(gateUpdate?.actorCode, "G09");
  assert.equal(gateUpdate?.actor_name, "Gate G09");
  assert.equal(gateUpdate?.description, `Gate G09 updated ticket ${ticketNo}.`);
  assert.equal(cancelledBooth?.cancellation?.cancelled_by_type, "gate");
  assert.equal(cancelledBooth?.cancellation?.cancelled_by_name, "Gate G09");
  assert.ok(arrival);
  assert.equal(arrival.actorCode, null);
  assert.ok(history.timeline.every((entry) => "actorCode" in entry));
});

// Type รายการ Timeline แบบ PascalCase ตามที่ Frontend ได้รับจริง
type RawTimelineEntry = {
  Type: string;
  Description: string;
  EventId?: string;
  TicketNo?: string | null;
  ChangeSummary?: Record<string, unknown> | null;
  ChangeDetails?: Array<Record<string, unknown>> | null;
};

// Function ดึง Work History แบบ raw PascalCase (ไม่แปลง key กลับ) แล้วคืน Gate update ของรถคันแรก
async function requestRawGateUpdates(adminToken: string) {
  const response = await server.request("GET", "/api/admin/vehicle-jobs/history", {
    token: adminToken,
    external: true,
  });

  assert.equal(response.status, 200, JSON.stringify(response.body));

  const timeline = response.body.Data[0].Timeline as RawTimelineEntry[];

  return {
    raw: JSON.stringify(response.body),
    gateUpdates: timeline.filter((entry) => entry.Type === "GATE_TICKET_UPDATED"),
  };
}

test("GET /api/admin/vehicle-jobs/history GATE_TICKET_UPDATED carries a stable EventId, TicketNo, ChangeSummary and ChangeDetails for several changes in one PUT, without full snapshots", async () => {
  const headers = await gateAuthHeaders();
  const ticketNo = await createTwoBoothTicket(headers);
  const { token: adminToken } = await loginJobAdmin(980400);
  const stall004B = state.boothJobs.find((booth) => booth.boothCode === "STALL-004-B");
  const stall004BProduct = state.ticketProducts.find((product) => product.ticket_id === stall004B?.id);

  const response = await putGateTicket(ticketNo, headers, {
    MarketCode: "MARKET-004",
    DropoffPoint: "Dropoff-004-NEW",
    Booths: [
      { BoothCode: "STALL-004", Products: [product("02030103", "19", 100)] },
      { BoothCode: "STALL-004-B", Products: [product("02020300", "29", 40)] },
    ],
  });

  assert.equal(response.status, 200);

  const updateLog = state.gateRequestLogs.find((log) => log.request_type === "UPDATE");
  const first = await requestRawGateUpdates(adminToken);
  const second = await requestRawGateUpdates(adminToken);
  const [event] = first.gateUpdates;

  assert.ok(updateLog && stall004B && stall004BProduct);
  assert.equal(first.gateUpdates.length, 1);
  assert.equal(event.EventId, `gate_request:${updateLog.id}:updated`);
  assert.equal(second.gateUpdates[0].EventId, event.EventId);
  assert.equal(event.TicketNo, ticketNo);
  assert.deepEqual(event.ChangeSummary, {
    MarketChanged: false,
    DropoffPointChanged: true,
    AddedBoothCodes: [],
    UpdatedBoothCodes: ["STALL-004-B"],
    RemovedBoothCodes: [],
    PreviousWorkerCount: response.body.Changes.PreviousWorkerCount,
    WorkerCount: response.body.Changes.WorkerCount,
  });

  const details = event.ChangeDetails ?? [];
  const productUpdate = details.find((detail) => detail.Type === "PRODUCT_UPDATED");

  assert.deepEqual(details.find((detail) => detail.Type === "DROPOFF_POINT_CHANGED"), {
    Type: "DROPOFF_POINT_CHANGED",
    Before: "Dropoff-004",
    After: "Dropoff-004-NEW",
  });
  assert.equal(
    details.some((detail) => detail.Type === "WORKER_COUNT_CHANGED"),
    response.body.Changes.PreviousWorkerCount !== response.body.Changes.WorkerCount
  );
  assert.ok(productUpdate);
  assert.equal(productUpdate.BoothJobId, String(stall004B.id));
  assert.equal(productUpdate.BoothCode, "STALL-004-B");
  assert.equal(productUpdate.TicketProductId, String(stall004BProduct.id));
  assert.equal(productUpdate.ProductCode, "02020300");
  assert.ok((productUpdate.Fields as string[]).includes("QUANTITY"));
  assert.equal((productUpdate.Before as { Quantity: number }).Quantity, 180);
  assert.equal((productUpdate.After as { Quantity: number }).Quantity, 40);
  // แผงที่ไม่เปลี่ยนไม่ถูกแนบ และไม่มี snapshot ทั้งก้อนใน Work History
  assert.equal(details.some((detail) => detail.BoothCode === "STALL-004"), false);
  assert.equal(first.raw.includes("BeforeSnapshot"), false);
  assert.equal(first.raw.includes("AfterSnapshot"), false);
  assert.equal(JSON.stringify(event).includes("Unchanged"), false);
});

test("GET /api/admin/vehicle-jobs/history ChangeDetails lists market change, removed and added booths in one Gate event", async () => {
  const headers = await gateAuthHeaders();
  const ticketNo = await createTwoBoothTicket(headers);
  const { token: adminToken } = await loginJobAdmin(980500);
  const originalBoothIds = state.boothJobs.map((booth) => String(booth.id));

  await putGateTicket(ticketNo, headers, {
    MarketCode: "MARKET-005",
    DropoffPoint: "Dropoff-004",
    Booths: [{ BoothCode: "STALL-005", Products: [product("02030103", "19", 40)] }],
  });

  const addedBooth = state.boothJobs.find((booth) => booth.boothCode === "STALL-005");
  const { gateUpdates } = await requestRawGateUpdates(adminToken);
  const details = gateUpdates[0].ChangeDetails ?? [];

  assert.ok(addedBooth);
  assert.equal(gateUpdates.length, 1);
  assert.deepEqual(details.find((detail) => detail.Type === "MARKET_CHANGED")?.Before, {
    MarketCode: "MARKET-004",
    MarketName: "Market A",
  });
  assert.equal((details.find((detail) => detail.Type === "MARKET_CHANGED")?.After as { MarketCode: string }).MarketCode, "MARKET-005");
  assert.equal(details.some((detail) => detail.Type === "DROPOFF_POINT_CHANGED"), false);
  assert.deepEqual(
    details.filter((detail) => detail.Type === "BOOTH_REMOVED").map((detail) => detail.BoothJobId).sort(),
    [...originalBoothIds].sort()
  );

  const boothAdded = details.find((detail) => detail.Type === "BOOTH_ADDED");

  assert.equal(boothAdded?.BoothJobId, String(addedBooth.id));
  assert.equal(boothAdded?.BoothCode, "STALL-005");
  assert.equal((boothAdded?.After as { Products: Array<{ Quantity: number }> }).Products[0].Quantity, 40);
});

test("GET /api/admin/vehicle-jobs/history ChangeDetails reports a product added to and removed from a booth by TicketProductId", async () => {
  const headers = await gateAuthHeaders();
  const ticketNo = await createTwoBoothTicket(headers);
  const { token: adminToken } = await loginJobAdmin(980600);
  const stall004 = state.boothJobs.find((booth) => booth.boothCode === "STALL-004");

  await putGateTicket(ticketNo, headers, {
    MarketCode: "MARKET-004",
    DropoffPoint: "Dropoff-004",
    Booths: [
      { BoothCode: "STALL-004", Products: [product("02030103", "19", 100), product("02020300", "29", 10)] },
      { BoothCode: "STALL-004-B", Products: [product("02020300", "29", 180)] },
    ],
  });

  const addedProduct = state.ticketProducts.find(
    (item) => item.ticket_id === stall004?.id && item.productCode === "02020300"
  );

  await putGateTicket(ticketNo, headers, {
    MarketCode: "MARKET-004",
    DropoffPoint: "Dropoff-004",
    Booths: [
      { BoothCode: "STALL-004", Products: [product("02030103", "19", 100)] },
      { BoothCode: "STALL-004-B", Products: [product("02020300", "29", 180)] },
    ],
  });

  const { gateUpdates } = await requestRawGateUpdates(adminToken);
  const added = gateUpdates[0].ChangeDetails?.find((detail) => detail.Type === "PRODUCT_ADDED");
  const removed = gateUpdates[1].ChangeDetails?.find((detail) => detail.Type === "PRODUCT_REMOVED");

  assert.ok(stall004 && addedProduct);
  assert.equal(gateUpdates.length, 2);
  assert.equal(added?.BoothJobId, String(stall004.id));
  assert.equal(added?.TicketProductId, String(addedProduct.id));
  assert.deepEqual(added?.After, { Quantity: 10, WorkerCount: addedProduct.required_worker_count_snapshot });
  assert.equal(removed?.TicketProductId, String(addedProduct.id));
  assert.equal((removed?.Before as { Quantity: number }).Quantity, 10);
});

/* -------------------------------------- Admin Worker Status Route Tests -------------------------------------- */

test("request log carries TicketNumber/TicketNo and the error code so a case can be searched by ticket", async () => {
  const { pinoLogger } = await import("../../src/config/logger");
  const headers = await gateAuthHeaders();
  const body = buildBoothJobJobBody("003");
  const logs: Array<Record<string, unknown>> = [];
  const originals = { info: pinoLogger.info, warn: pinoLogger.warn };
  const capture = (context: Record<string, unknown>, message: string) => {
    if (message === "Request completed.") {
      logs.push(context);
    }
  };

  pinoLogger.info = capture as typeof pinoLogger.info;
  pinoLogger.warn = capture as typeof pinoLogger.warn;

  try {
    await server.request("POST", "/api/gate/tickets", { body, headers });
    await server.request("POST", "/api/gate/tickets", { body: { ...body, LicensePlate: "DIFFERENT-003" }, headers });
    await server.request("GET", `/api/gate/tickets/${body.Markets[0].TicketNo}`, { headers });
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    pinoLogger.info = originals.info;
    pinoLogger.warn = originals.warn;
  }

  const [created, duplicate, lookup] = logs;

  assert.equal(logs.length, 3);
  assert.equal(created.ticketNumber, body.TicketNumber);
  assert.deepEqual(created.ticketNos, [body.Markets[0].TicketNo]);
  assert.equal(created.errorCode, undefined);
  assert.equal(duplicate.statusCode, 409);
  assert.equal(duplicate.errorCode, "GATE_TICKET_ALREADY_EXISTS");
  assert.equal(duplicate.ticketNumber, body.TicketNumber);
  // Gate request ที่ถูกปฏิเสธไม่ถูกบันทึกใน gate_request_logs จึงเก็บ body และรายละเอียด error ไว้ใน request log
  assert.equal((duplicate.errorDetails as { ticketNo?: string }).ticketNo, body.Markets[0].TicketNo);
  assert.equal((duplicate.body as { LicensePlate?: string }).LicensePlate, "DIFFERENT-003");
  assert.equal(created.body, undefined);
  assert.equal(lookup.ticketNo, body.Markets[0].TicketNo);
  assert.equal(lookup.ticketNumber, body.TicketNumber);
  assert.equal(typeof lookup.requestId, "string");
});
