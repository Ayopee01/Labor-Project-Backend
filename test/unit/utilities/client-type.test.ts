import assert from "node:assert/strict";
import test from "node:test";

import { CLIENT_TYPE, detectClientType } from "../../../src/utils/client-type";

import type { Request } from "express";

// Function สร้าง fake Express Request ขั้นต่ำสำหรับทดสอบ detectClientType() โดยไม่ต้องตั้ง server จริง
function buildRequest(input: {
  originalUrl: string;
  auth?: { role: string };
  headers?: Record<string, string>;
}): Request {
  const headers = input.headers ?? {};

  return {
    originalUrl: input.originalUrl,
    path: input.originalUrl.split("?")[0],
    auth: input.auth as Request["auth"],
    header: (name: string) => headers[name.toLowerCase()],
  } as unknown as Request;
}

test("detectClientType identifies worker_app from the /api/workers path prefix", () => {
  const req = buildRequest({ originalUrl: "/api/workers/me/status" });

  assert.equal(detectClientType(req), CLIENT_TYPE.WORKER_APP);
});

test("detectClientType identifies admin_webapp from any /api/admin* path prefix", () => {
  assert.equal(
    detectClientType(buildRequest({ originalUrl: "/api/admin/users" })),
    CLIENT_TYPE.ADMIN_WEBAPP,
  );
  assert.equal(
    detectClientType(buildRequest({ originalUrl: "/api/admin/vehicle-jobs/history" })),
    CLIENT_TYPE.ADMIN_WEBAPP,
  );
});

test("detectClientType identifies driver_webapp from the /api/driver path prefix", () => {
  const req = buildRequest({ originalUrl: "/api/driver/jobs/current" });

  assert.equal(detectClientType(req), CLIENT_TYPE.DRIVER_WEBAPP);
});

test("detectClientType identifies gate from the /api/gate path prefix", () => {
  const req = buildRequest({ originalUrl: "/api/gate/tickets" });

  assert.equal(detectClientType(req), CLIENT_TYPE.GATE);
});

test("detectClientType identifies line_oa from the /api/line path prefix", () => {
  const req = buildRequest({ originalUrl: "/api/line/webhook" });

  assert.equal(detectClientType(req), CLIENT_TYPE.LINE_OA);
});

test("detectClientType strips the query string before matching the path prefix", () => {
  const req = buildRequest({
    originalUrl: "/api/workers/me/status?includeSchedule=true",
  });

  assert.equal(detectClientType(req), CLIENT_TYPE.WORKER_APP);
});

test("detectClientType on the shared /api/auth prefix uses req.auth.role over the header when both are present (role is more reliable)", () => {
  const req = buildRequest({
    originalUrl: "/api/auth/me",
    auth: { role: "admin" },
    headers: { "x-client-type": "worker_app" },
  });

  assert.equal(detectClientType(req), CLIENT_TYPE.ADMIN_WEBAPP);
});

test("detectClientType maps req.auth.role=worker to worker_app on /api/auth (e.g. POST /push-token)", () => {
  const req = buildRequest({
    originalUrl: "/api/auth/push-token",
    auth: { role: "worker" },
  });

  assert.equal(detectClientType(req), CLIENT_TYPE.WORKER_APP);
});

test("detectClientType falls back to the X-Client-Type header on /api/auth routes that are not authenticated yet (login/refresh)", () => {
  const req = buildRequest({
    originalUrl: "/api/auth/login",
    headers: { "x-client-type": "admin_webapp" },
  });

  assert.equal(detectClientType(req), CLIENT_TYPE.ADMIN_WEBAPP);
});

test("detectClientType header lookup is case-insensitive on the value", () => {
  const req = buildRequest({
    originalUrl: "/api/auth/refresh",
    headers: { "x-client-type": "WORKER_APP" },
  });

  assert.equal(detectClientType(req), CLIENT_TYPE.WORKER_APP);
});

test("detectClientType returns unknown for /api/auth with no auth and no header (never throws)", () => {
  const req = buildRequest({ originalUrl: "/api/auth/refresh" });

  assert.equal(detectClientType(req), CLIENT_TYPE.UNKNOWN);
});

test("detectClientType returns unknown for an unrecognized header value instead of trusting arbitrary client input", () => {
  const req = buildRequest({
    originalUrl: "/api/auth/login",
    headers: { "x-client-type": "some-made-up-client" },
  });

  assert.equal(detectClientType(req), CLIENT_TYPE.UNKNOWN);
});

test("detectClientType returns unknown for a path outside every known prefix (e.g. /ready)", () => {
  const req = buildRequest({ originalUrl: "/ready" });

  assert.equal(detectClientType(req), CLIENT_TYPE.UNKNOWN);
});
