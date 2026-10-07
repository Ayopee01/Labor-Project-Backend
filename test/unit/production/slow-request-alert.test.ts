// Import Library
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { beforeEach, mock, test } from "node:test";
import type { Request, Response } from "express";
// Import Config
import { pinoLogger } from "../../../src/config/logger";
// Import Middlewares
import { requestLoggerMiddleware } from "../../../src/middlewares/request-logger.middleware";

/* -------------------------------------- Setup -------------------------------------- */

// Config เก็บ error log ที่เกิดขึ้นระหว่าง test (ไม่เขียน stdout)
const errorLogs: Array<{ message: string; context: Record<string, unknown> }> = [];

(pinoLogger as unknown as Record<string, unknown>).error = (context: Record<string, unknown>, message: string) => {
  errorLogs.push({ message, context });
};

mock.timers.enable({ apis: ["setTimeout"] });

// Function สร้าง Request ปลอม (contentType ใช้จำลอง multipart upload)
function buildRequest(contentType = "application/json"): Request {
  return {
    requestId: "slow-request-1",
    method: "POST",
    path: "/api/gate/booth-jobs",
    originalUrl: "/api/gate/booth-jobs",
    header: () => undefined,
    is: (type: string) => (type === contentType ? type : false),
  } as unknown as Request;
}

// Function สร้าง Response ปลอมที่ยิง event finish/close ได้
function buildResponse(): Response & EventEmitter {
  return Object.assign(new EventEmitter(), { headersSent: false, statusCode: 200, locals: {} }) as unknown as Response & EventEmitter;
}

beforeEach(() => {
  errorLogs.length = 0;
});

/* -------------------------------------- Tests -------------------------------------- */

test("a request still waiting after 15 seconds reports SLOW_REQUEST to Sentry", () => {
  const res = buildResponse();
  requestLoggerMiddleware(buildRequest(), res, () => undefined);

  mock.timers.tick(15_000);

  assert.equal(errorLogs.length, 1);
  assert.equal(errorLogs[0].message, "Request is taking too long.");
  assert.equal(errorLogs[0].context.alertCode, "SLOW_REQUEST");
  assert.equal(errorLogs[0].context.path, "/api/gate/booth-jobs");
});

test("a request that responds in time does not report SLOW_REQUEST", () => {
  const res = buildResponse();
  requestLoggerMiddleware(buildRequest(), res, () => undefined);

  mock.timers.tick(5_000);
  res.emit("close");
  mock.timers.tick(15_000);

  assert.equal(errorLogs.length, 0);
});

test("streams that already sent headers (SSE) and multipart uploads never report SLOW_REQUEST", () => {
  const streamResponse = buildResponse();
  requestLoggerMiddleware(buildRequest(), streamResponse, () => undefined);
  (streamResponse as unknown as { headersSent: boolean }).headersSent = true;

  requestLoggerMiddleware(buildRequest("multipart/form-data"), buildResponse(), () => undefined);

  mock.timers.tick(15_000);

  assert.equal(errorLogs.length, 0);
});
