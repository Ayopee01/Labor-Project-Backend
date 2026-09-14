import assert from "node:assert/strict";
import crypto from "node:crypto";
import test, { after, before } from "node:test";

import { restoreRouteTestLoader, startRouteTestServer, type TestServer } from "../helpers/app-test-harness";
import { clearRateLimitBuckets } from "../../src/middlewares/security.middleware";
import { cleanupRateLimitBucketsForTest, getRateLimitBucketCountForTest, stopRateLimitCleanupTimer } from "../../src/middlewares/security.middleware";

let server: TestServer;

before(async () => {
  server = await startRouteTestServer();
});

after(async () => {
  delete process.env.TEST_READY_DB_FAIL;
  delete process.env.TEST_READY_REDIS_FAIL;
  delete process.env.RATE_LIMIT_MAX_REQUESTS;
  delete process.env.RATE_LIMIT_WINDOW_MS;
  delete process.env.LINE_CHANNEL_SECRET;
  stopRateLimitCleanupTimer();
  await server.close();
  restoreRouteTestLoader();
});

test("rate limiter cleanup removes stale one-off client buckets", async () => {
  process.env.RATE_LIMIT_WINDOW_MS = "1";
  process.env.RATE_LIMIT_MAX_REQUESTS = "100";
  clearRateLimitBuckets();

  const firstAuth = await server.request("POST", "/api/auth/login", {
    body: {},
  });

  await new Promise((resolve) => setTimeout(resolve, 5));
  cleanupRateLimitBucketsForTest(Date.now());

  delete process.env.RATE_LIMIT_MAX_REQUESTS;
  delete process.env.RATE_LIMIT_WINDOW_MS;

  assert.notEqual(firstAuth.status, 429);
  assert.equal(getRateLimitBucketCountForTest(), 0);
});

test("GET /health is not exposed because /ready is the single health check", async () => {
  const response = await server.request("GET", "/health");

  assert.equal(response.status, 404);
});

test("GET / behaves the same as /ready", async () => {
  const response = await server.request("GET", "/");

  assert.equal(response.status, 200);
  assert.equal(response.body.status, "ready");
  assert.equal(response.body.checks.database.status, "ok");
  assert.equal(response.body.checks.redis.status, "ok");
});

test("GET /ready returns ready when DB and Redis checks pass", async () => {
  const response = await server.request("GET", "/ready");

  assert.equal(response.status, 200);
  assert.equal(response.body.status, "ready");
  assert.equal(response.body.checks.database.status, "ok");
  assert.equal(response.body.checks.redis.status, "ok");
});

test("GET /ready returns not_ready when DB check fails", async () => {
  process.env.TEST_READY_DB_FAIL = "1";

  const response = await server.request("GET", "/ready");

  delete process.env.TEST_READY_DB_FAIL;
  assert.equal(response.status, 503);
  assert.equal(response.body.status, "not_ready");
  assert.equal(response.body.checks.database.status, "error");
  assert.equal(response.body.checks.database.message, undefined);
});

test("GET /ready returns not_ready when Redis check fails", async () => {
  process.env.TEST_READY_REDIS_FAIL = "1";

  const response = await server.request("GET", "/ready");

  delete process.env.TEST_READY_REDIS_FAIL;
  assert.equal(response.status, 503);
  assert.equal(response.body.status, "not_ready");
  assert.equal(response.body.checks.redis.status, "error");
  assert.equal(response.body.checks.redis.message, undefined);
});

test("request ID middleware preserves inbound request ID", async () => {
  const requestId = "route-test-request-id";
  const response = await server.request("GET", "/ready", {
    headers: {
      "x-request-id": requestId,
    },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-request-id"), requestId);
});

test("rate limiter targets auth/admin routes but not ready or LINE webhook", async () => {
  process.env.RATE_LIMIT_WINDOW_MS = "60000";
  process.env.RATE_LIMIT_MAX_REQUESTS = "1";
  clearRateLimitBuckets();

  const firstAuth = await server.request("POST", "/api/auth/login", {
    body: {},
  });
  const secondAuth = await server.request("POST", "/api/auth/login", {
    body: {},
  });
  const firstReady = await server.request("GET", "/ready");
  const secondReady = await server.request("GET", "/ready");
  const lineBody = { events: [] };
  const lineSignature = crypto
    .createHmac("sha256", process.env.LINE_CHANNEL_SECRET!)
    .update(JSON.stringify(lineBody))
    .digest("base64");
  const firstLine = await server.request("POST", "/api/line/webhook", {
    headers: { "x-line-signature": lineSignature },
    body: lineBody,
  });
  const secondLine = await server.request("POST", "/api/line/webhook", {
    headers: { "x-line-signature": lineSignature },
    body: lineBody,
  });

  delete process.env.RATE_LIMIT_MAX_REQUESTS;
  delete process.env.RATE_LIMIT_WINDOW_MS;
  clearRateLimitBuckets();

  assert.notEqual(firstAuth.status, 429);
  assert.equal(secondAuth.status, 429);
  assert.equal(firstReady.status, 200);
  assert.equal(secondReady.status, 200);
  assert.equal(firstLine.status, 200);
  assert.equal(secondLine.status, 200);
});

test("LINE webhook fails closed when channel secret is missing", async () => {
  delete process.env.LINE_CHANNEL_SECRET;

  const response = await server.request("POST", "/api/line/webhook", {
    body: { events: [] },
  });

  assert.equal(response.status, 503);
  assert.equal(response.body.code, "LINE_WEBHOOK_NOT_CONFIGURED");
});

test("LINE webhook rejects invalid signatures when channel secret is configured", async () => {
  process.env.LINE_CHANNEL_SECRET = "line-test-secret";

  try {
    const response = await server.request("POST", "/api/line/webhook", {
      headers: {
        "x-line-signature": "invalid-signature",
      },
      body: { events: [] },
    });

    assert.equal(response.status, 401);
    assert.equal(response.body.code, "INVALID_LINE_SIGNATURE");
  } finally {
    delete process.env.LINE_CHANNEL_SECRET;
  }
});

test("LINE webhook accepts valid signatures when channel secret is configured", async () => {
  process.env.LINE_CHANNEL_SECRET = "line-test-secret";
  const body = { events: [] };
  const rawBody = JSON.stringify(body);
  const signature = crypto
    .createHmac("sha256", process.env.LINE_CHANNEL_SECRET)
    .update(rawBody)
    .digest("base64");

  try {
    const response = await server.request("POST", "/api/line/webhook", {
      headers: {
        "x-line-signature": signature,
      },
      body,
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.processed, 0);
  } finally {
    delete process.env.LINE_CHANNEL_SECRET;
  }
});
