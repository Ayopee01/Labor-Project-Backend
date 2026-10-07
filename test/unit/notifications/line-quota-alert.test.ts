// Import Library
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import type { ErrorEvent } from "@sentry/node";
import Module = require("node:module");
// Import Config
import { pinoLogger } from "../../../src/config/logger";
import { Sentry } from "../../../src/config/sentry";

/* -------------------------------------- Fakes -------------------------------------- */

// Type ส่วน signature ของ Module._load
type ModuleLoad = (request: string, parent: NodeModule | null | undefined, isMain: boolean) => unknown;
const moduleWithLoad = Module as typeof Module & { _load: ModuleLoad };
const originalLoad = moduleWithLoad._load;

// Type ส่วน worker ปลอมที่เก็บ processor และ failed handler ไว้ให้ test เรียกเอง
type FakeWorker = {
  processor: (job: { id: string; data: unknown }) => Promise<void>;
  failedHandler?: (job: { id: string } | undefined, error: Error) => void;
};

// State ของ fake ที่แต่ละ test กำหนด response ของ LINE และตรวจสิ่งที่ถูกเขียนกลับ
const fake = {
  workers: [] as FakeWorker[],
  responses: new Map<string, { status: number; body: unknown }>(),
  statusUpdates: [] as Array<{ status: string; error: string | null }>,
  errorLogs: [] as Array<{ message: string; context: Record<string, unknown> }>,
  sentryEvents: [] as ErrorEvent[],
};

// แทน BullMQ/Redis/Repository ด้วย fake ก่อน require queue
moduleWithLoad._load = function patchedLoad(request, parent, isMain) {
  if (request === "bullmq") {
    class UnrecoverableError extends Error {}

    return {
      UnrecoverableError,
      Queue: class {
        add = async () => undefined;
        close = async () => undefined;
      },
      Worker: class {
        constructor(_name: string, processor: FakeWorker["processor"]) {
          const worker: FakeWorker = { processor };
          fake.workers.push(worker);
          (this as unknown as { on: (event: string, handler: FakeWorker["failedHandler"]) => void }).on = (event, handler) => {
            if (event === "failed") {
              worker.failedHandler = handler;
            }
          };
        }
      },
    };
  }

  if (request.endsWith("config/redis.config")) {
    return { buildBullConnection: () => ({}), REDIS_CONFIG: { lineMessageQueueName: "test-line-messages" } };
  }

  if (request.endsWith("repositories/shared/message-delivery-log.repository")) {
    return {
      MESSAGE_DELIVERY_STATUS: { PENDING: "PENDING", SENT: "SENT", FAILED: "FAILED" },
      createMessageDeliveryLog: async () => 1,
      updateMessageDeliveryLogStatus: async (_id: number, status: string, error: string | null = null) => {
        fake.statusUpdates.push({ status, error });
      },
    };
  }

  return originalLoad.call(this, request, parent, isMain);
};

const lineMessageQueue = require("../../../src/queues/line-message-queue") as typeof import("../../../src/queues/line-message-queue");

moduleWithLoad._load = originalLoad;

// แทน fetch ด้วย response ที่ test กำหนดตาม URL (ไม่ออกเน็ตจริง)
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  const response = fake.responses.get(url);

  if (!response) {
    throw new Error(`Unexpected fetch: ${url}`);
  }

  return new Response(typeof response.body === "string" ? response.body : JSON.stringify(response.body), { status: response.status });
}) as typeof fetch;

// เก็บ error log และ Sentry event แทนการเขียน stdout/ส่งออกเน็ต
(pinoLogger as unknown as Record<string, unknown>).error = (context: Record<string, unknown>, message: string) => {
  fake.errorLogs.push({ message, context });
};

Sentry.init({
  dsn: "https://public@o0.ingest.sentry.io/0",
  beforeSend: (event) => {
    fake.sentryEvents.push(event);
    return null;
  },
});

process.env.LINE_CHANNEL_ACCESS_TOKEN = "test-line-token";

const PUSH_URL = "https://api.line.me/v2/bot/message/push";
const QUOTA_URL = "https://api.line.me/v2/bot/message/quota";
const CONSUMPTION_URL = "https://api.line.me/v2/bot/message/quota/consumption";

// Function ตั้งโควต้าและจำนวนที่ใช้ไปของ LINE ปลอม
function setQuota(quota: { type: "none" | "limited"; value?: number }, totalUsage: number): void {
  fake.responses.set(QUOTA_URL, { status: 200, body: quota });
  fake.responses.set(CONSUMPTION_URL, { status: 200, body: { totalUsage } });
}

// Function รัน LINE job ผ่าน worker ปลอม แล้วส่ง error เข้า failed handler เหมือน BullMQ
async function runLineJob(): Promise<Error | undefined> {
  const worker = fake.workers[0];

  try {
    await worker.processor({ id: "job-1", data: { log_id: 1, to: "U123", messages: [], retry_key: "retry-1" } });
    return undefined;
  } catch (error) {
    worker.failedHandler?.({ id: "job-1" }, error as Error);
    return error as Error;
  }
}

lineMessageQueue.startLineMessageWorker();

beforeEach(async () => {
  // ส่ง Sentry event ที่ค้างจาก test ก่อนหน้าออกให้หมดก่อนล้าง ไม่งั้นไปปนกับ test ถัดไป
  await Sentry.flush(2000);
  fake.responses.clear();
  fake.statusUpdates.length = 0;
  fake.errorLogs.length = 0;
  fake.sentryEvents.length = 0;
});

/* -------------------------------------- Quota Check Tests -------------------------------------- */

test("LINE quota check stays silent below 80% usage", async () => {
  setQuota({ type: "limited", value: 1000 }, 799);

  await lineMessageQueue.checkLineMessageQuota();

  assert.equal(fake.errorLogs.length, 0);
});

test("LINE quota check reports LINE_QUOTA_LOW to Sentry at 80% usage with used/limit/percent", async () => {
  setQuota({ type: "limited", value: 1000 }, 800);

  await lineMessageQueue.checkLineMessageQuota();
  await Sentry.flush(2000);

  assert.equal(fake.errorLogs.length, 1);
  assert.equal(fake.errorLogs[0].message, "LINE monthly message quota is running low.");
  assert.deepEqual(
    { used: fake.errorLogs[0].context.used, limit: fake.errorLogs[0].context.limit, percent: fake.errorLogs[0].context.percent },
    { used: 800, limit: 1000, percent: 80 }
  );
  assert.equal(fake.sentryEvents.length, 1);
  assert.equal(fake.sentryEvents[0].tags?.alert_code, "LINE_QUOTA_LOW");
});

test("LINE quota check reports LINE_QUOTA_CRITICAL at 95% usage instead of LINE_QUOTA_LOW", async () => {
  setQuota({ type: "limited", value: 1000 }, 960);

  await lineMessageQueue.checkLineMessageQuota();

  assert.equal(fake.errorLogs.length, 1);
  assert.equal(fake.errorLogs[0].message, "LINE monthly message quota is nearly exhausted.");
  assert.equal(fake.errorLogs[0].context.alertCode, "LINE_QUOTA_CRITICAL");
});

test("LINE quota check skips plans without a monthly limit", async () => {
  setQuota({ type: "none" }, 50000);

  await lineMessageQueue.checkLineMessageQuota();

  assert.equal(fake.errorLogs.length, 0);
});

test("LINE quota check throws when the LINE quota API fails so the job failure reaches Sentry", async () => {
  fake.responses.set(QUOTA_URL, { status: 401, body: { message: "Authentication failed" } });
  fake.responses.set(CONSUMPTION_URL, { status: 401, body: { message: "Authentication failed" } });

  await assert.rejects(lineMessageQueue.checkLineMessageQuota(), /LINE quota request failed with 401/);
});

/* -------------------------------------- Push Failure Tests -------------------------------------- */

test("LINE push 429 monthly limit fails without retry and reports LINE_QUOTA_EXHAUSTED as its own issue", async () => {
  fake.responses.set(PUSH_URL, { status: 429, body: { message: "You have reached your monthly limit." } });

  const error = await runLineJob();
  await Sentry.flush(2000);

  assert.ok(error instanceof lineMessageQueue.LineQuotaExhaustedError);
  assert.equal(fake.statusUpdates[0].status, "FAILED");
  assert.match(fake.statusUpdates[0].error ?? "", /LINE push failed with 429/);
  assert.equal(fake.errorLogs[0].message, "LINE monthly message quota exhausted.");
  assert.equal(fake.sentryEvents[0].tags?.alert_code, "LINE_QUOTA_EXHAUSTED");
  assert.equal(fake.sentryEvents[0].message, "LINE monthly message quota exhausted.");
});

test("LINE push 429 rate limit stays a normal retryable failure", async () => {
  fake.responses.set(PUSH_URL, { status: 429, body: { message: "The API rate limit has been exceeded. Try again later." } });

  const error = await runLineJob();

  assert.ok(error);
  assert.ok(!(error instanceof lineMessageQueue.LineQuotaExhaustedError));
  assert.equal(fake.errorLogs[0].message, "LINE message job failed.");
});
