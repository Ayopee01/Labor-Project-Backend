// Import Library
import assert from "node:assert/strict";
import test from "node:test";
import { Prisma } from "@prisma/client";
// Import Middlewares
import { errorHandler } from "../../../src/middlewares/error.middleware";
// Import Helpers
import { buildFakeContext, type FakeContext } from "../../helpers/fake-context";
// Import Utils
import ApiError from "../../../src/utils/api-error";

// Function ดัก stdout ระหว่าง callback แล้วคืนข้อความที่เขียนออกมา
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

// Function สร้าง context ปลอมของ request ที่ล้มเหลว
function buildRequest(overrides: { path?: string; originalUrl?: string; body?: unknown; requestId?: string; method?: string } = {}): FakeContext {
  return buildFakeContext({
    method: overrides.method ?? "POST",
    path: overrides.path ?? "/api/auth/login",
    variables: { requestId: overrides.requestId ?? "test-request-id-1", body: overrides.body ?? {} },
  });
}

test("errorHandler redacts the password field from the request body before it ever reaches log output (regression: password must never leak to logs)", () => {
  const req = buildRequest({
    body: { username: "admin1", password: "super-secret-password" },
  });
  const res = req;

  const output = captureStdout(() => {
    errorHandler(
      new ApiError(500, "INTERNAL_SERVER_ERROR", "boom"), req);
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
  const res = req;

  const output = captureStdout(() => {
    errorHandler(
      new ApiError(500, "INTERNAL_SERVER_ERROR", "boom"), req);
  });

  const logLine = JSON.parse(output.trim().split("\n").pop() as string);

  assert.equal(logLine.requestId, "test-request-id-1");
  assert.equal(logLine.path, "/api/admin/users");
  assert.equal(logLine.body.full_name, "Worker A");
  assert.equal(logLine.body.password, "[REDACTED]");
});

test("errorHandler does not log or capture context for a 4xx client error (only 5xx is treated as a real failure)", () => {
  const req = buildRequest({ body: { password: "should-not-log" } });
  const res = req;

  const output = captureStdout(() => {
    errorHandler(
      new ApiError(404, "NOT_FOUND", "Route not found."), req);
  });

  assert.equal(output, "");
  // request log ยังได้ error code ไปบันทึกแม้ 4xx ไม่ออก error log
  assert.equal(res.get("errorCode"), "NOT_FOUND");
});

test("errorHandler logs a 4xx missing-configuration error as an error with alertCode so it reaches Sentry", () => {
  const req = buildRequest({ path: "/api/gate/booth-jobs", originalUrl: "/api/gate/booth-jobs" });
  const res = req;

  const output = captureStdout(() => {
    errorHandler(
      new ApiError(409, "MARKET_NAME_NOT_CONFIGURED", "Master market name is not configured.", { marketCode: "M01", boothCode: "B01" }), req);
  });

  const logLine = JSON.parse(output.trim().split("\n").pop() as string);

  assert.equal(res.statusCode, 409);
  assert.equal(logLine.level, "error");
  assert.equal(logLine.message, "Request rejected because of missing configuration: MARKET_NAME_NOT_CONFIGURED.");
  assert.equal(logLine.alertCode, "MARKET_NAME_NOT_CONFIGURED");
  assert.deepEqual(logLine.details, { marketCode: "M01", boothCode: "B01" });
});

test("errorHandler always returns requestId in the JSON error response body", () => {
  const req = buildRequest({ requestId: "trace-me-later" });
  const res = req;

  captureStdout(() => {
    errorHandler(
      new ApiError(400, "VALIDATION_ERROR", "Invalid input."), req);
  });

  assert.equal(res.statusCode, 400);
  assert.equal((res.jsonBody as { RequestId?: string }).RequestId, "trace-me-later");
});

test("errorHandler turns lock-wait timeouts and deadlocks into 409 TRANSACTION_CONFLICT so the client can retry", () => {
  const errors = [
    new Prisma.PrismaClientKnownRequestError("Transaction already closed", { code: "P2028", clientVersion: "test" }),
    new Prisma.PrismaClientKnownRequestError("Write conflict or deadlock", { code: "P2034", clientVersion: "test" }),
    new Prisma.PrismaClientKnownRequestError("Raw query failed", {
      code: "P2010",
      clientVersion: "test",
      meta: { code: "40P01", message: "deadlock detected" },
    }),
  ];

  for (const error of errors) {
    const req = buildRequest();
    const res = req;

    captureStdout(() => errorHandler(error, req));

    assert.equal(res.statusCode, 409, error.code);
    assert.equal((res.jsonBody as { Code?: string }).Code, "TRANSACTION_CONFLICT", error.code);
  }
});
