import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import WebSocket from "ws";

import {
  applyIsolatedTestEnv,
  assertSafeTestDatabaseUrl,
  assertSafeTestRedisUrl,
} from "../setup/test-env";

/* -------------------------------------- Config -------------------------------------- */

const runDbTests = process.env.RUN_DB_TESTS === "1";

// ต่อ Postgres + Redis จริงทั้งคู่ ผ่าน HTTP + WebSocket จริง (ไม่ mock อะไรเลย) — เดินตาม flow เต็ม
// ระบบตาม docs/flow.md Step 1-8: Gate สร้าง Ticket -> Dispatch -> Worker Accept -> Check-in ->
// Team Ready -> ส่งยอด -> Vendor Confirm (ผ่าน LINE dev tool) -> Financialize/กลับคิว
// ดู test/e2e/README.md
let prismaModule: typeof import("../../src/db/prisma");
let workerQueueModule: typeof import("../../src/queues/worker-queue");
let workerSocketModule: typeof import("../../src/websockets/worker.socket");
let httpServer: Server;
let baseUrl: string;

/* -------------------------------------- Helpers -------------------------------------- */

async function apiRequest(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; auth?: string } = {}
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  if (options.auth) {
    headers.Authorization = `Basic ${Buffer.from(options.auth).toString("base64")}`;
  }

  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : null;

  return { status: response.status, body };
}

// Function ดึงเวลาปัจจุบันตามเขตเวลา Asia/Bangkok เป็นนาที (0-1439)
function getCurrentBangkokMinutes(): number {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = formatter.formatToParts(new Date());
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);

  return hour * 60 + minute;
}

function formatMinutesAsTime(totalMinutes: number): string {
  const wrapped = ((totalMinutes % 1440) + 1440) % 1440;
  const hour = Math.floor(wrapped / 60);
  const minute = wrapped % 60;

  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function buildAlwaysActiveSchedule(): { time_in: string; time_out: string } {
  const nowMinutes = getCurrentBangkokMinutes();

  return {
    time_in: formatMinutesAsTime(nowMinutes - 180),
    time_out: formatMinutesAsTime(nowMinutes + 180),
  };
}

function buildFourteenDigitId(): string {
  const combined = `${Date.now()}${randomInt(0, 10)}`;

  return combined.slice(-14).padStart(14, "0");
}

// Function ห่อ WebSocket ให้รอ event ชนิดที่ต้องการได้ (buffer ข้อความที่มาก่อนเรียกรอไว้ด้วย)
class WorkerSocketRecorder {
  private readonly received: any[] = [];
  private readonly waiters: Array<{ type: string; resolve: (value: any) => void }> = [];

  constructor(socket: WebSocket) {
    socket.on("message", (raw: WebSocket.RawData) => {
      const event = JSON.parse(raw.toString());
      this.received.push(event);

      const waiterIndex = this.waiters.findIndex((waiter) => waiter.type === event.Type);

      if (waiterIndex !== -1) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        waiter.resolve(event);
      }
    });
  }

  async waitFor(type: string, timeoutMs = 15000): Promise<any> {
    const already = this.received.find((event) => event.Type === type);

    if (already) {
      return already;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolveWrapped);
        if (index !== -1) {
          this.waiters.splice(index, 1);
        }
        reject(new Error(`Timed out waiting for WebSocket event "${type}". Received so far: ${JSON.stringify(this.received.map((e) => e.Type))}`));
      }, timeoutMs);

      const resolveWrapped = (value: any) => {
        clearTimeout(timer);
        resolve(value);
      };

      this.waiters.push({ type, resolve: resolveWrapped });
    });
  }
}

/* -------------------------------------- Setup -------------------------------------- */

before(async () => {
  if (!runDbTests) {
    return;
  }

  applyIsolatedTestEnv("concurrency");
  assertSafeTestDatabaseUrl();
  assertSafeTestRedisUrl();

  prismaModule = await import("../../src/db/prisma");
  workerQueueModule = await import("../../src/queues/worker-queue");
  workerSocketModule = await import("../../src/websockets/worker.socket");
  const { default: app } = await import("../../src/app");

  httpServer = createServer(app);
  workerSocketModule.setupWorkerWebSocket(httpServer);

  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
  });

  const address = httpServer.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (!runDbTests) {
    return;
  }

  if (workerSocketModule) {
    await workerSocketModule.closeWorkerWebSocketServer();
  }

  if (httpServer) {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }

  if (workerQueueModule) {
    await workerQueueModule.closeWorkerQueueConnections();
  }

  if (prismaModule) {
    await prismaModule.closePrisma();
  }
});

/* -------------------------------------- Test -------------------------------------- */

test(
  "full worker job lifecycle over real HTTP + WebSocket: login -> online -> gate dispatch -> accept -> check-in -> submit -> vendor confirm -> financialize",
  {
    skip: runDbTests
      ? false
      : "Set RUN_DB_TESTS=1 and run PostgreSQL + Redis before this test.",
  },
  async () => {
    const suffix = Date.now().toString(36);
    const marketCode = `E2E-MKT-${suffix}`;
    const boothCode = `E2E-BOOTH-${suffix}`;
    const productCode = `E2E-PRD-${suffix}`;
    const packageCode = `E2E-PKG-${suffix}`;
    const ticketNumber = buildFourteenDigitId();
    const ticketNo = buildFourteenDigitId();
    const workerPassword = "E2E-test-password-1234";
    const gateClientSecret = "E2E-test-gate-secret-1234";
    const schedule = buildAlwaysActiveSchedule();

    const masterProductId = 910_000_000 + randomInt(0, 1_000_000);
    const masterMarketBoothId = 910_000_000 + randomInt(0, 1_000_000);
    const masterRateSourceId = 910_000_000 + randomInt(0, 1_000_000);
    const gateClientId = `e2e-gate-client-${suffix}`;

    let workerId: number | null = null;
    let socket: WebSocket | null = null;
    let testError: unknown;

    try {
      const { prisma } = prismaModule;
      const { hashPassword } = await import("../../src/utils/password");

      // --- Master data: market/booth, product+package, rate, vendor LINE mapping ---
      await prisma.masterMarket.create({
        data: {
          sourceBoothId: masterMarketBoothId,
          marketCode,
          marketName: "E2E Test Market",
          boothCode,
          boothName: "E2E Test Booth",
          boothStatus: "Normal",
          marketStatus: "Normal",
        },
      });
      await prisma.masterProduct.create({
        data: {
          id: masterProductId,
          productCode,
          productFullCode: productCode,
          productName: "E2E Test Product",
          packageCode,
          packageName: "E2E Test Package",
          packageWeight: 20,
          range: {
            workerRanges: {
              range1To50: 1,
              range51To100: 1,
              range101To200: 1,
              range201To400: 1,
              range401To600: 1,
              rangeOver600: 1,
            },
          },
          status: "ACTIVE",
          updateDate: new Date(),
        },
      });
      await prisma.masterRate.create({
        data: {
          sourceRateId: masterRateSourceId,
          marketCode,
          weightRangeName: "10-30",
          weightMin: 10,
          weightMax: 30,
          stallRate: 5,
          laborRate: 3,
          status: 1,
        },
      });
      await prisma.masterOwnerStall.create({
        data: {
          marketCode,
          boothCode,
          cardId: `E2E-CARD-${suffix}`,
          ownerStatus: "Normal",
          lineUserId: `Ue2e${suffix}`,
          status: "active",
        },
      });

      // --- Gate client (Basic Auth) ---
      await prisma.gateClient.create({
        data: {
          clientId: gateClientId,
          name: "E2E Test Gate Client",
          secretHash: await hashPassword(gateClientSecret),
          status: "active",
        },
      });

      // --- Worker account with an always-active work schedule ---
      const worker = await prisma.masterWorker.create({
        data: {
          laborCode: `E2E-WORKER-${suffix}`,
          status: 1,
          fullName: "E2E Test Worker",
          shiftName: "Morning",
          timeIn: schedule.time_in,
          timeOut: schedule.time_out,
          passwordHash: await hashPassword(workerPassword),
        },
      });

      workerId = worker.id;

      // --- Step: Worker logs in ---
      const login = await apiRequest("POST", "/api/auth/login", {
        body: {
          username: worker.laborCode,
          password: workerPassword,
          device_id: `e2e-device-${suffix}`,
          device_name: "E2E Test Device",
        },
      });

      assert.equal(login.status, 200, JSON.stringify(login.body));
      const accessToken = login.body.AccessToken;
      assert.ok(accessToken, "Login must return an AccessToken.");

      // --- Step: Worker connects the real WebSocket and waits for WORKER_CONNECTED ---
      socket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws/workers?token=${accessToken}`);
      const recorder = new WorkerSocketRecorder(socket);

      await new Promise<void>((resolve, reject) => {
        socket!.once("open", () => resolve());
        socket!.once("error", reject);
      });
      await recorder.waitFor("WORKER_CONNECTED");

      // --- Step: Worker goes online (enters the Redis FIFO ready queue) ---
      const online = await apiRequest("POST", "/api/workers/me/online", { token: accessToken });

      assert.equal(online.status, 200, JSON.stringify(online.body));

      // --- Step: Gate creates the ticket with Dispatch=true (triggers real dispatch synchronously) ---
      const gateBody = {
        TicketNumber: ticketNumber,
        TicketNo: ticketNo,
        TicketCreatedAt: new Date().toISOString(),
        BoothCount: 1,
        MarketCode: marketCode,
        DropoffPoint: "Zone E2E",
        LicensePlate: "1กก-8888",
        LicensePlateProvince: "Bangkok",
        VehicleTypeCode: "TRUCK",
        VehicleTypeName: "Truck",
        Booths: [
          {
            BoothCode: boothCode,
            Products: [
              {
                ProductCode: productCode,
                PackageCode: packageCode,
                Quantity: 10,
              },
            ],
          },
        ],
        Dispatch: true,
      };

      const gateResponse = await apiRequest("POST", "/api/gate/tickets", {
        body: gateBody,
        auth: `${gateClientId}:${gateClientSecret}`,
      });

      assert.equal(gateResponse.status, 201, JSON.stringify(gateResponse.body));
      assert.equal(gateResponse.body.WorkerCount, 1, "This product/range setup must require exactly 1 worker.");

      // --- Step: Worker receives WORKER_ASSIGNED over the real WebSocket ---
      const assignedEvent = await recorder.waitFor("WORKER_ASSIGNED");

      assert.equal(assignedEvent.Payload.TicketNumber, ticketNumber);

      // --- Step: Worker accepts the assignment over real HTTP ---
      const accept = await apiRequest("POST", `/api/workers/me/assignments/${ticketNumber}/accept`, {
        token: accessToken,
      });

      assert.equal(accept.status, 200, JSON.stringify(accept.body));
      assert.equal(accept.body.Markets[0].TicketNo, ticketNo);

      // --- Step: Worker scans the Business Ticket barcode to check in ---
      const checkIn = await apiRequest("POST", "/api/workers/me/assignments/check-in-barcode", {
        token: accessToken,
        body: { ticket_no: ticketNo },
      });

      assert.equal(checkIn.status, 200, JSON.stringify(checkIn.body));

      // --- Step: whole team (this one worker) is now ready — real WebSocket TEAM_READY event ---
      await recorder.waitFor("TEAM_READY");

      // --- Step: Worker submits counted quantities for the booth ---
      const complete = await apiRequest("POST", "/api/workers/me/assignments/tickets/complete", {
        token: accessToken,
        body: {
          ticket_no: ticketNo,
          boothCode,
          items: [
            {
              productCode,
              packageCode,
              confirmed_quantity: 10,
            },
          ],
        },
      });

      assert.equal(complete.status, 200, JSON.stringify(complete.body));

      // --- Step: Vendor confirms via the LINE dev tool (same flow as a real LINE postback) ---
      const submissions = await apiRequest("GET", "/api/line/dev/submissions");

      assert.equal(submissions.status, 200, JSON.stringify(submissions.body));
      const submission = submissions.body.Data.find(
        (item: any) => item.TicketNumber === ticketNumber
      );

      assert.ok(submission, "The submission for this TicketNumber must appear in the LINE dev tool list.");

      const confirm = await apiRequest(
        "POST",
        `/api/line/dev/submissions/${submission.SubmissionId}/confirm`
      );

      assert.equal(confirm.status, 200, JSON.stringify(confirm.body));

      // --- Step: Worker receives the final TICKET_COMPLETION_RESULT over the real WebSocket ---
      await recorder.waitFor("TICKET_COMPLETION_RESULT");

      // --- Verify final persisted state directly against real PostgreSQL ---
      const finalTicketJob = await prisma.ticketJob.findUnique({ where: { ticketNumber } });

      assert.ok(finalTicketJob, "TicketJob must still exist.");
      assert.equal(finalTicketJob!.status, "COMPLETED", "TicketJob must be COMPLETED after vendor confirmation.");
      assert.ok(finalTicketJob!.completedAt, "completedAt must be set.");

      const finalBoothJob = await prisma.boothJob.findFirst({
        where: { ticketJobId: finalTicketJob!.id, boothCode },
      });

      assert.ok(finalBoothJob, "BoothJob must still exist.");
      assert.equal(finalBoothJob!.status, "COMPLETED");
      assert.ok(finalBoothJob!.financializedAt, "Booth must be financialized.");

      const financial = await prisma.ticketProductFinancial.findFirst({
        where: { product: { ticketId: finalBoothJob!.id } },
      });

      assert.ok(financial, "TicketProductFinancial must be persisted for the completed booth.");

      // --- Step: worker returns to the Redis FIFO queue (still within its active schedule) ---
      const finalStatus = await apiRequest("GET", "/api/workers/me/status", { token: accessToken });

      assert.equal(finalStatus.status, 200, JSON.stringify(finalStatus.body));
      // current_job เป็น optional field — โค้ดไม่ใส่ key นี้เข้า response เลยตอนไม่มีงานปัจจุบัน
      // (ไม่ใช่ใส่เป็น null) จึงต้องเช็คว่า falsy เฉยๆ ไม่ใช่เทียบเท่ากับ null ตรงๆ
      assert.ok(!finalStatus.body.CurrentJob, "Worker must have no current job after completion.");
      assert.equal(finalStatus.body.Status, "ready", "Worker must be back in the ready queue.");
    } catch (error) {
      // เก็บ error จริงของ test ไว้ก่อน — ถ้า cleanup ด้านล่าง fail ซ้ำ (เช่น ลำดับลบผิดจน FK ชน)
      // ต้อง throw error ตัวนี้ต่อ ไม่ใช่ปล่อยให้ error ของ cleanup บัง error จริงจนมองไม่เห็นสาเหตุ
      testError = error;
    } finally {
      try {
        if (socket) {
          socket.close();
        }

        const { prisma } = prismaModule;
        const ticketJob = await prisma.ticketJob.findUnique({ where: { ticketNumber } });

        if (ticketJob) {
          const boothJobs = await prisma.boothJob.findMany({
            where: { ticketJobId: ticketJob.id },
            select: { id: true },
          });
          const boothJobIds = boothJobs.map((ticket) => ticket.id);

          if (boothJobIds.length > 0) {
            await prisma.ticketProduct.deleteMany({ where: { ticketId: { in: boothJobIds } } });
          }

          // ต้องลบ BoothJob ก่อน TicketJobAssignment เสมอ — TicketCompletionSubmission (ลูกของ
          // BoothJob, cascade) ยังอ้าง assignment_id อยู่ ถ้าลบ assignment ก่อนจะชน FK constraint
          await prisma.boothJob.deleteMany({ where: { ticketJobId: ticketJob.id } });
          await prisma.ticketJobAssignment.deleteMany({ where: { ticketJobId: ticketJob.id } });
          await prisma.gateRequestLog.deleteMany({ where: { ticketJobId: ticketJob.id } });
          await prisma.marketJob.deleteMany({ where: { ticketJobId: ticketJob.id } });
          await prisma.ticketJob.delete({ where: { id: ticketJob.id } });
        }

        if (workerId !== null) {
          await workerQueueModule.markWorkerOpenApp(workerId);
          // user_sessions (role: worker) ยังอ้าง worker_id อยู่ (สร้างตอน login) ต้องลบก่อน MasterWorker เสมอ
          await prisma.userSession.deleteMany({ where: { workerId } });
          await prisma.masterWorker.deleteMany({ where: { id: workerId } });
        }

        await prisma.gateClient.deleteMany({ where: { clientId: gateClientId } });
        await prisma.masterOwnerStall.deleteMany({ where: { marketCode, boothCode } });
        await prisma.masterRate.deleteMany({ where: { sourceRateId: masterRateSourceId } });
        await prisma.masterProduct.deleteMany({ where: { id: masterProductId } });
        await prisma.masterMarket.deleteMany({ where: { sourceBoothId: masterMarketBoothId } });
      } catch (cleanupError) {
        // eslint-disable-next-line no-console
        console.error("E2E test cleanup failed:", cleanupError);
      }
    }

    if (testError) {
      throw testError;
    }
  }
);
