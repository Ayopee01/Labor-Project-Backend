import assert from "node:assert/strict";
import test from "node:test";

import { errorHandler } from "../../../src/middlewares/error.middleware";
import ApiError from "../../../src/utils/api-error";

import type { Request, Response } from "express";

// Function ดัก process.stdout.write ระหว่าง callback แล้วคืน log line ที่เขียนออกมาทั้งหมดเป็น string เดียว
// (pino เขียนแบบ sync ตอน test env — ดู src/config/logger.ts — จึงอ่านผลได้ทันทีแบบ deterministic)
function captureStdout(callback: () => void): string {
  const originalWrite = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];

  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(chunk.toString());
    return true;
  }) as typeof process.stdout.write;

  try {
    callback();
  } finally {
    process.stdout.write = originalWrite;
  }

  return chunks.join("");
}

function buildRequest(overrides: Partial<Request> = {}): Request {
  return {
    requestId: "test-request-id-1",
    method: "POST",
    path: "/api/auth/login",
    originalUrl: "/api/auth/login",
    body: {},
    header: () => undefined,
    ...overrides,
  } as Request;
}

function buildResponse(): Response & { statusCode?: number; jsonBody?: unknown } {
  const res = {} as Response & { statusCode?: number; jsonBody?: unknown };

  res.status = ((code: number) => {
    res.statusCode = code;
    return res;
  }) as Response["status"];
  res.json = ((body: unknown) => {
    res.jsonBody = body;
    return res;
  }) as Response["json"];

  return res;
}

test("errorHandler redacts the password field from the request body before it ever reaches log output (regression: password must never leak to logs)", () => {
  const req = buildRequest({
    body: { username: "admin1", password: "super-secret-password" },
  });
  const res = buildResponse();

  const output = captureStdout(() => {
    errorHandler(
      new ApiError(500, "INTERNAL_SERVER_ERROR", "boom"),
      req,
      res,
      () => undefined,
    );
  });

  assert.ok(
    !output.includes("super-secret-password"),
    "raw password value must not appear anywhere in log output",
  );
  assert.ok(
    output.includes("[REDACTED]"),
    "password field must be replaced with the redaction marker",
  );
});

test("errorHandler includes the redacted request body, requestId, and path in the 5xx log context", () => {
  const req = buildRequest({
    method: "POST",
    path: "/api/admin/users",
    originalUrl: "/api/admin/users",
    body: { full_name: "Worker A", password: "another-secret" },
  });
  const res = buildResponse();

  const output = captureStdout(() => {
    errorHandler(
      new ApiError(500, "INTERNAL_SERVER_ERROR", "boom"),
      req,
      res,
      () => undefined,
    );
  });

  const logLine = JSON.parse(output.trim().split("\n").pop() as string);

  assert.equal(logLine.requestId, "test-request-id-1");
  assert.equal(logLine.path, "/api/admin/users");
  assert.equal(logLine.body.full_name, "Worker A");
  assert.equal(logLine.body.password, "[REDACTED]");
});

test("errorHandler does not log or capture context for a 4xx client error (only 5xx is treated as a real failure)", () => {
  const req = buildRequest({ body: { password: "should-not-log" } });
  const res = buildResponse();

  const output = captureStdout(() => {
    errorHandler(
      new ApiError(404, "NOT_FOUND", "Route not found."),
      req,
      res,
      () => undefined,
    );
  });

  assert.equal(output, "");
});

test("errorHandler always returns requestId in the JSON error response body", () => {
  const req = buildRequest({ requestId: "trace-me-later" });
  const res = buildResponse();

  captureStdout(() => {
    errorHandler(
      new ApiError(400, "VALIDATION_ERROR", "Invalid input."),
      req,
      res,
      () => undefined,
    );
  });

  assert.equal(res.statusCode, 400);
  assert.equal((res.jsonBody as { requestId?: string }).requestId, "trace-me-later");
});
