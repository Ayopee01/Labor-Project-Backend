import assert from "node:assert/strict";
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

// ตั้ง grace period ของ Worker WebSocket disconnect ให้สั้นลงมากสำหรับเทสนี้โดยเฉพาะ (ของจริง
// default 15000ms) เพื่อให้เทส "รอ grace period" ใช้เวลาจริงหลักวินาที ไม่ใช่หลักสิบวินาที — ต้องตั้ง
// ก่อน import worker.socket.ts ครั้งแรกเสมอ เพราะค่านี้ถูกอ่านครั้งเดียวตอน module load
const GRACE_MS = 1200;
process.env.WORKER_SOCKET_DISCONNECT_GRACE_MS = String(GRACE_MS);

// ต่อ Postgres + Redis จริง ผ่าน HTTP + WebSocket จริง — ทดสอบเฉพาะกลไก realtime เอง (heartbeat,
// disconnect grace period, reconnect, force-disconnect ตอน logout, Admin SSE) แยกจาก e2e ที่ทดสอบ
// business flow เต็มระบบ ดู test/realtime/README.md
let prismaModule: typeof import("../../src/db/prisma");
let workerQueueModule: typeof import("../../src/queues/worker-queue");
let workerSocketModule: typeof import("../../src/websockets/worker.socket");
let httpServer: Server;
let baseUrl: string;

/* -------------------------------------- Helpers -------------------------------------- */

async function apiRequest(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {}
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};

  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Function เชื่อมต่อ Worker WebSocket จริงแล้วคืน client พร้อมรอ WORKER_CONNECTED ก่อนคืนค่า
async function connectWorkerSocket(accessToken: string): Promise<WebSocket> {
  const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/ws/workers?token=${accessToken}`);

  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for WORKER_CONNECTED.")), 5000);

    socket.once("message", (raw: WebSocket.RawData) => {
      clearTimeout(timer);
      const event = JSON.parse(raw.toString());

      if (event.Type === "WORKER_CONNECTED") {
        resolve();
      } else {
        reject(new Error(`Expected WORKER_CONNECTED first, got ${event.Type}`));
      }
    });
  });

  return socket;
}

// Function อ่าน Server-Sent Events จาก Admin realtime endpoint แบบ real HTTP stream (ไม่ mock)
class SseRecorder {
  private readonly received: Array<{ event: string; data: any }> = [];
  private readonly waiters: Array<{
    predicate: (event: { event: string; data: any }) => boolean;
    resolve: (value: { event: string; data: any }) => void;
  }> = [];
  private buffer = "";
  readonly abortController = new AbortController();
  private readonly donePromise: Promise<void>;

  constructor(private readonly url: string, private readonly token: string) {
    this.donePromise = this.start();
  }

  private async start(): Promise<void> {
    const response = await fetch(this.url, {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: this.abortController.signal,
    });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    try {
      for (;;) {
        const { value, done } = await reader.read();

        if (done) {
          return;
        }

        this.buffer += decoder.decode(value, { stream: true });
        this.drainBuffer();
      }
    } catch (error) {
      if (this.abortController.signal.aborted) {
        return;
      }
      throw error;
    }
  }

  private drainBuffer(): void {
    let boundary = this.buffer.indexOf("\n\n");

    while (boundary !== -1) {
      const rawBlock = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      boundary = this.buffer.indexOf("\n\n");

      const lines = rawBlock.split("\n").filter((line) => !line.startsWith(":"));
      const eventLine = lines.find((line) => line.startsWith("event:"));
      const dataLine = lines.find((line) => line.startsWith("data:"));

      if (!eventLine || !dataLine) {
        continue;
      }

      const event = eventLine.slice("event:".length).trim();
      const dataText = dataLine.slice("data:".length).trim();
      const data = JSON.parse(dataText);

      this.received.push({ event, data });

      const waiterIndex = this.waiters.findIndex((waiter) => waiter.predicate({ event, data }));

      if (waiterIndex !== -1) {
        const [waiter] = this.waiters.splice(waiterIndex, 1);
        waiter.resolve({ event, data });
      }
    }
  }

  async waitFor(
    predicate: (event: { event: string; data: any }) => boolean,
    timeoutMs = 5000
  ): Promise<{ event: string; data: any }> {
    const already = this.received.find(predicate);

    if (already) {
      return already;
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((waiter) => waiter.resolve === resolveWrapped);
        if (index !== -1) {
          this.waiters.splice(index, 1);
        }
        reject(new Error(`Timed out waiting for matching SSE event. Received so far: ${JSON.stringify(this.received)}`));
      }, timeoutMs);

      const resolveWrapped = (value: { event: string; data: any }) => {
        clearTimeout(timer);
        resolve(value);
      };

      this.waiters.push({ predicate, resolve: resolveWrapped });
    });
  }

  // Function ยืนยันว่าไม่มี event ที่ตรงเงื่อนไขเกิดขึ้นภายในเวลาที่กำหนด (ใช้พิสูจน์ grace period)
  async assertNoneWithin(
    predicate: (event: { event: string; data: any }) => boolean,
    windowMs: number
  ): Promise<void> {
    await sleep(windowMs);
    const match = this.received.find(predicate);

    assert.equal(match, undefined, `Expected no matching SSE event within ${windowMs}ms, but found: ${JSON.stringify(match)}`);
  }

  async close(): Promise<void> {
    this.abortController.abort();
    await this.donePromise.catch(() => undefined);
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
  "Worker WebSocket disconnect grace period, reconnect suppression, force-disconnect on logout, and Admin SSE all behave correctly over real HTTP + WebSocket",
  {
    skip: runDbTests
      ? false
      : "Set RUN_DB_TESTS=1 and run PostgreSQL + Redis before this test.",
  },
  async () => {
    const suffix = Date.now().toString(36);
    const workerPassword = "RT-test-password-1234";
    const adminPassword = "RT-test-admin-password-1234";
    const schedule = buildAlwaysActiveSchedule();

    let workerId: number | null = null;
    let adminId: number | null = null;
    let sse: SseRecorder | null = null;
    let socket: WebSocket | null = null;
    let testError: unknown;

    try {
      const { prisma } = prismaModule;
      const { hashPassword } = await import("../../src/utils/password");

      const worker = await prisma.masterWorker.create({
        data: {
          laborCode: `RT-WORKER-${suffix}`,
          status: 1,
          fullName: "Realtime Test Worker",
          timeWork: "Morning",
          timeIn: schedule.time_in,
          timeOut: schedule.time_out,
          passwordHash: await hashPassword(workerPassword),
        },
      });

      workerId = worker.id;

      const admin = await prisma.account.create({
        data: {
          username: `rt-admin-${suffix}`,
          passwordHash: await hashPassword(adminPassword),
          role: "admin",
          status: "active",
          fullName: "Realtime Test Admin",
        },
      });

      adminId = admin.id;

      await prisma.accountPermission.create({
        data: { accountId: admin.id, permission: "jobs:read" },
      });

      const workerLogin = await apiRequest("POST", "/api/auth/login", {
        body: {
          username: worker.laborCode,
          password: workerPassword,
          device_id: `rt-device-${suffix}`,
          device_name: "Realtime Test Device",
        },
      });

      assert.equal(workerLogin.status, 200, JSON.stringify(workerLogin.body));
      const workerToken = workerLogin.body.AccessToken;

      const adminLogin = await apiRequest("POST", "/api/auth/login", {
        body: {
          username: admin.username,
          password: adminPassword,
          device_id: `rt-admin-device-${suffix}`,
          device_name: "Realtime Test Admin Device",
        },
      });

      assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.body));
      const adminToken = adminLogin.body.AccessToken;

      // --- Admin เปิด SSE ก่อน แล้วรอ event "connected" แรกเสมอ ---
      sse = new SseRecorder(`${baseUrl}/api/admin/events`, adminToken);
      await sse.waitFor((event) => event.event === "connected");

      // --- Worker เปิด WebSocket จริง — Admin SSE ต้องเห็น WORKER_CONNECTION_CHANGED (connected) ---
      socket = await connectWorkerSocket(workerToken);
      const connectedEvent = await sse.waitFor(
        (event) =>
          event.event === "WORKER_CONNECTION_CHANGED" &&
          event.data.Payload?.WorkerCode === worker.laborCode &&
          event.data.Payload?.SocketConnected === true
      );

      assert.ok(connectedEvent, "Admin SSE must see the worker connect immediately.");

      // --- Worker socket หลุดกะทันหัน (จำลองเน็ตกระตุก ไม่ใช่ logout) ---
      socket.terminate();

      // --- ภายใน grace period ต้องยังไม่เห็น disconnected event ---
      await sse.assertNoneWithin(
        (event) =>
          event.event === "WORKER_CONNECTION_CHANGED" &&
          event.data.Payload?.WorkerCode === worker.laborCode &&
          event.data.Payload?.SocketConnected === false,
        Math.floor(GRACE_MS * 0.5)
      );

      // --- พ้น grace period แล้วต้องเห็น disconnected event ---
      const disconnectedEvent = await sse.waitFor(
        (event) =>
          event.event === "WORKER_CONNECTION_CHANGED" &&
          event.data.Payload?.WorkerCode === worker.laborCode &&
          event.data.Payload?.SocketConnected === false,
        GRACE_MS
      );

      assert.ok(disconnectedEvent, "Admin SSE must see the worker disconnect after the grace period elapses.");

      // --- Reconnect ภายใน grace period ต้องไม่มี disconnected event สำหรับรอบนี้เกิดขึ้นเลย ---
      const eventsBeforeReconnectCycle = (sse as any).received.length;
      socket = await connectWorkerSocket(workerToken);
      socket.terminate();
      await sleep(Math.floor(GRACE_MS * 0.4));
      socket = await connectWorkerSocket(workerToken);
      await sleep(GRACE_MS + 500);

      const eventsDuringReconnectCycle: Array<{ event: string; data: any }> = (sse as any).received.slice(
        eventsBeforeReconnectCycle
      );
      const disconnectedDuringReconnect = eventsDuringReconnectCycle.find(
        (event) =>
          event.event === "WORKER_CONNECTION_CHANGED" &&
          event.data.Payload?.WorkerCode === worker.laborCode &&
          event.data.Payload?.SocketConnected === false
      );

      assert.equal(
        disconnectedDuringReconnect,
        undefined,
        "Reconnecting within the grace period must suppress the disconnected event entirely."
      );

      // --- Logout ต้องตัด WebSocket ทันที ไม่ต้องรอ grace period ---
      const socketCloseSpy = new Promise<void>((resolve) => {
        socket!.once("close", () => resolve());
      });

      const logout = await apiRequest("POST", "/api/auth/logout", { token: workerToken });

      assert.equal(logout.status, 200, JSON.stringify(logout.body));

      await Promise.race([
        socketCloseSpy,
        sleep(2000).then(() => {
          throw new Error("WebSocket did not close promptly after logout.");
        }),
      ]);

      const disconnectedAfterLogout = await sse.waitFor(
        (event) =>
          event.event === "WORKER_CONNECTION_CHANGED" &&
          event.data.Payload?.WorkerCode === worker.laborCode &&
          event.data.Payload?.SocketConnected === false &&
          event.data.Payload?.Reason === "worker_logout",
        2000
      );

      assert.ok(
        disconnectedAfterLogout,
        "Logout must publish the disconnected event immediately, well before the grace period would have elapsed."
      );

      socket = null;
    } catch (error) {
      testError = error;
    } finally {
      try {
        if (socket) {
          socket.close();
        }

        if (sse) {
          await sse.close();
        }

        const { prisma } = prismaModule;

        if (workerId !== null) {
          await workerQueueModule.markWorkerOpenApp(workerId);
          await prisma.userSession.deleteMany({ where: { workerId } });
          await prisma.masterWorker.deleteMany({ where: { id: workerId } });
        }

        if (adminId !== null) {
          await prisma.accountPermission.deleteMany({ where: { accountId: adminId } });
          await prisma.userSession.deleteMany({ where: { accountId: adminId } });
          await prisma.account.deleteMany({ where: { id: adminId } });
        }
      } catch (cleanupError) {
        // eslint-disable-next-line no-console
        console.error("Realtime test cleanup failed:", cleanupError);
      }
    }

    if (testError) {
      throw testError;
    }
  }
);

test(
  "TOKEN_NEARING_EXPIRY fires over both the Worker WebSocket and the Admin SSE stream before their connecting access token expires",
  {
    skip: runDbTests
      ? false
      : "Set RUN_DB_TESTS=1 and run PostgreSQL + Redis before this test.",
  },
  async () => {
    const suffix = `tne-${Date.now().toString(36)}`;
    const workerPassword = "RT-tne-password-1234";
    const adminPassword = "RT-tne-admin-password-1234";
    const schedule = buildAlwaysActiveSchedule();

    let workerId: number | null = null;
    let adminId: number | null = null;
    let sse: SseRecorder | null = null;
    let socket: WebSocket | null = null;
    let testError: unknown;
    // ACCESS_TOKEN_REFRESH_THRESHOLD ถูกอ่านสดทุกครั้ง (auth.config.ts) จึง mutate ตอน runtime ได้จริง
    // ต่างจาก JWT_ACCESS_EXPIRES_IN ที่ jwt.ts cache ไว้ตอน import ครั้งแรก (เหตุผลเดียวกับที่ต้องเซ็น
    // access token เองด้วย expiresIn สั้นๆ ตรงๆ แทนการพึ่ง env ด้านล่าง)
    const previousThreshold = process.env.ACCESS_TOKEN_REFRESH_THRESHOLD;

    try {
      process.env.ACCESS_TOKEN_REFRESH_THRESHOLD = "1s";

      const { prisma } = prismaModule;
      const { hashPassword } = await import("../../src/utils/password");
      const { signAccessToken } = await import("../../src/utils/jwt");

      const worker = await prisma.masterWorker.create({
        data: {
          laborCode: `RT-WORKER-${suffix}`,
          status: 1,
          fullName: "Realtime TNE Test Worker",
          timeWork: "Morning",
          timeIn: schedule.time_in,
          timeOut: schedule.time_out,
          passwordHash: await hashPassword(workerPassword),
        },
      });

      workerId = worker.id;

      const admin = await prisma.account.create({
        data: {
          username: `rt-tne-admin-${suffix}`,
          passwordHash: await hashPassword(adminPassword),
          role: "admin",
          status: "active",
          fullName: "Realtime TNE Test Admin",
        },
      });

      adminId = admin.id;

      await prisma.accountPermission.create({
        data: { accountId: admin.id, permission: "jobs:read" },
      });

      // Login จริงเพื่อสร้าง session ใน DB ให้ authenticateWorkerSocket/sessionMiddleware เจอ session
      // active จริง — แต่ access token ที่ login คืนมาอายุยาวตาม JWT_ACCESS_EXPIRES_IN ปกติ (cache ไว้
      // ตอน import) จึงต้องเซ็น token สั้นๆ เองอีกทีโดยใช้ session_id เดียวกันด้านล่าง
      const workerLogin = await apiRequest("POST", "/api/auth/login", {
        body: {
          username: worker.laborCode,
          password: workerPassword,
          device_id: `rt-tne-device-${suffix}`,
          device_name: "Realtime TNE Test Device",
        },
      });

      assert.equal(workerLogin.status, 200, JSON.stringify(workerLogin.body));

      const adminLogin = await apiRequest("POST", "/api/auth/login", {
        body: {
          username: admin.username,
          password: adminPassword,
          device_id: `rt-tne-admin-device-${suffix}`,
          device_name: "Realtime TNE Test Admin Device",
        },
      });

      assert.equal(adminLogin.status, 200, JSON.stringify(adminLogin.body));

      const decodeSessionId = (accessToken: string): number =>
        JSON.parse(Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8")).session_id;

      const shortLivedWorkerToken = signAccessToken(
        {
          account_id: worker.id,
          role: "worker",
          permission_level: null,
          permissions: [],
          session_id: decodeSessionId(workerLogin.body.AccessToken),
        },
        { expiresIn: "3s" }
      );
      const shortLivedAdminToken = signAccessToken(
        {
          account_id: admin.id,
          role: "admin",
          permission_level: null,
          permissions: ["jobs:read"],
          session_id: decodeSessionId(adminLogin.body.AccessToken),
        },
        { expiresIn: "3s" }
      );

      sse = new SseRecorder(`${baseUrl}/api/admin/events`, shortLivedAdminToken);
      await sse.waitFor((event) => event.event === "connected");

      socket = await connectWorkerSocket(shortLivedWorkerToken);

      const workerReminder = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Timed out waiting for TOKEN_NEARING_EXPIRY on the worker socket.")),
          4000
        );

        socket!.on("message", (raw: WebSocket.RawData) => {
          const event = JSON.parse(raw.toString());

          if (event.Type === "TOKEN_NEARING_EXPIRY") {
            clearTimeout(timer);
            resolve();
          }
        });
      });

      await workerReminder;

      const adminReminderEvent = await sse.waitFor(
        (event) => event.event === "TOKEN_NEARING_EXPIRY",
        4000
      );

      assert.ok(
        adminReminderEvent,
        "Admin SSE must receive TOKEN_NEARING_EXPIRY before its connecting token expires."
      );

      socket.close();
      socket = null;
    } catch (error) {
      testError = error;
    } finally {
      if (previousThreshold === undefined) {
        delete process.env.ACCESS_TOKEN_REFRESH_THRESHOLD;
      } else {
        process.env.ACCESS_TOKEN_REFRESH_THRESHOLD = previousThreshold;
      }

      try {
        if (socket) {
          socket.close();
        }

        if (sse) {
          await sse.close();
        }

        const { prisma } = prismaModule;

        if (workerId !== null) {
          await workerQueueModule.markWorkerOpenApp(workerId);
          await prisma.userSession.deleteMany({ where: { workerId } });
          await prisma.masterWorker.deleteMany({ where: { id: workerId } });
        }

        if (adminId !== null) {
          await prisma.accountPermission.deleteMany({ where: { accountId: adminId } });
          await prisma.userSession.deleteMany({ where: { accountId: adminId } });
          await prisma.account.deleteMany({ where: { id: adminId } });
        }
      } catch (cleanupError) {
        // eslint-disable-next-line no-console
        console.error("Realtime TNE test cleanup failed:", cleanupError);
      }
    }

    if (testError) {
      throw testError;
    }
  }
);
