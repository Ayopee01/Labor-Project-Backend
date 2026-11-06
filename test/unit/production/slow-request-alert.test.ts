// Import Library
import assert from "node:assert/strict";
import { beforeEach, mock, test } from "node:test";
// Import Config
import { pinoLogger } from "../../../src/config/logger";
// Import Middlewares
import { slowRequestAlertMiddleware } from "../../../src/middlewares/request-logger.middleware";
// Import Helpers
import { buildFakeContext } from "../../helpers/fake-context";

/* -------------------------------------- Setup -------------------------------------- */

// Config เก็บ error log ที่เกิดขึ้นระหว่าง test (ไม่เขียน stdout)
const errorLogs: Array<{ message: string; context: Record<string, unknown> }> = [];

(pinoLogger as unknown as Record<string, unknown>).error = (context: Record<string, unknown>, message: string) => {
  errorLogs.push({ message, context });
};

mock.timers.enable({ apis: ["setTimeout"] });

// Function สร้าง context ปลอม (contentType ใช้จำลอง multipart upload)
function buildContext(contentType = "application/json") {
  return buildFakeContext({
    path: "/api/gate/booth-jobs",
    headers: { "content-type": contentType },
    variables: { requestId: "slow-request-1" },
  });
}

// Function เริ่ม middleware กับ handler ที่ยังไม่ตอบ คืน function จบ handler
function startPendingRequest(contentType?: string): () => Promise<void> {
  let finishHandler = (): void => undefined;
  const handler = new Promise<void>((resolve) => {
    finishHandler = resolve;
  });
  const middleware = slowRequestAlertMiddleware(buildContext(contentType), () => handler);

  return async () => {
    finishHandler();
    await middleware;
  };
}

beforeEach(() => {
  errorLogs.length = 0;
});

/* -------------------------------------- Tests -------------------------------------- */

test("a request still waiting after 15 seconds reports SLOW_REQUEST to Sentry", async () => {
  const finish = startPendingRequest();

  mock.timers.tick(15_000);
  await finish();

  assert.equal(errorLogs.length, 1);
  assert.equal(errorLogs[0].message, "Request is taking too long.");
  assert.equal(errorLogs[0].context.alertCode, "SLOW_REQUEST");
  assert.equal(errorLogs[0].context.path, "/api/gate/booth-jobs");
});

test("a request that responds in time does not report SLOW_REQUEST", async () => {
  const finish = startPendingRequest();

  mock.timers.tick(5_000);
  await finish();
  mock.timers.tick(15_000);

  assert.equal(errorLogs.length, 0);
});

test("multipart uploads never report SLOW_REQUEST", async () => {
  const finish = startPendingRequest("multipart/form-data");

  mock.timers.tick(15_000);
  await finish();

  assert.equal(errorLogs.length, 0);
});
