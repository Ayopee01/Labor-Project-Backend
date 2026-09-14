import assert from "node:assert/strict";
import test from "node:test";

import { buildRequestLogContext } from "../../../src/middlewares/request-logger.middleware";
import { createGracefulShutdownHandler } from "../../../src/runtime/shutdown";
import { logger } from "../../../src/utils/logger";

/* -------------------------------------- Tests -------------------------------------- */

test("logger redacts nested secret-shaped keys", () => {
  const redacted = logger.redact({
    Authorization: "Bearer token",
    nested: {
      database_url: "postgresql://secret",
      safe: "visible",
    },
  }) as Record<string, unknown>;

  assert.equal(redacted.Authorization, "[REDACTED]");
  assert.deepEqual(redacted.nested, {
    database_url: "[REDACTED]",
    safe: "visible",
  });
});

test("logger redacts secrets and URL credentials in Error fields", () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgresql://user:super-secret-password@db:5432/app";

  try {
    const redacted = logger.redact(
      new Error(
        "Unable to connect to postgresql://user:super-secret-password@db:5432/app",
      ),
    ) as Record<string, unknown>;

    assert.equal(
      redacted.message,
      "Unable to connect to postgresql://[REDACTED]:[REDACTED]@db:5432/app",
    );
  } finally {
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
  }
});

test("request completion logger context includes request id, duration, clientType, userId, and ip", () => {
  assert.deepEqual(
    buildRequestLogContext({
      requestId: "request-1",
      method: "GET",
      path: "/ready",
      statusCode: 503,
      durationMs: 12.3456,
      clientType: "admin_webapp",
      clientVersion: "1.2.0",
      userId: 42,
      ip: "127.0.0.1",
    }),
    {
      requestId: "request-1",
      method: "GET",
      path: "/ready",
      statusCode: 503,
      durationMs: 12.35,
      clientType: "admin_webapp",
      clientVersion: "1.2.0",
      userId: 42,
      ip: "127.0.0.1",
    },
  );
});

test("request completion logger context omits clientType/clientVersion/userId/ip cleanly when not provided", () => {
  assert.deepEqual(
    buildRequestLogContext({
      requestId: "request-2",
      method: "GET",
      path: "/api/line/webhook",
      statusCode: 200,
      durationMs: 1,
    }),
    {
      requestId: "request-2",
      method: "GET",
      path: "/api/line/webhook",
      statusCode: 200,
      durationMs: 1,
      clientType: undefined,
      clientVersion: undefined,
      userId: undefined,
      ip: undefined,
    },
  );
});

test("graceful shutdown waits for HTTP close to finish (drain in-flight requests) before closing WebSocket/Queue/Prisma", async () => {
  const events: string[] = [];
  let resolveWebSocketClose: (() => void) | undefined;
  const server = {
    close: (callback: (error?: Error) => void) => {
      events.push("http-close-start");
      setImmediate(() => {
        events.push("http-close-finish");
        callback();
      });
      return server;
    },
  };
  const shutdown = createGracefulShutdownHandler(server as never, {
    markReadinessShuttingDown: () => events.push("readiness-false"),
    closeHttpServer: (httpServer) =>
      new Promise((resolve, reject) => {
        httpServer.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    closeWorkerWebSocketServer: () =>
      new Promise((resolve) => {
        events.push("ws-close-start");
        resolveWebSocketClose = () => {
          events.push("ws-close-finish");
          resolve();
        };
      }),
    closeLineMessageQueueConnections: async () => {
      events.push("notification-close");
    },
    closeWorkerQueueConnections: async () => {
      events.push("worker-queue-close");
    },
    closeRuntimeSettingsSyncConnections: async () => {
      events.push("runtime-settings-sync-close");
    },
    closePrisma: async () => {
      events.push("prisma-close");
    },
    stopRateLimitCleanupTimer: () => events.push("rate-limit-stop"),
    logger: {
      info: () => undefined,
      error: () => undefined,
    },
    exit: (code) => events.push(`exit-${code}`),
    setTimeout: (() =>
      ({ unref: () => undefined }) as unknown as NodeJS.Timeout) as unknown as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
    readShutdownTimeoutMs: () => 20_000,
  });

  const shutdownPromise = shutdown("SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));

  // Test graceful shutdown waits for HTTP close before other dependencies
  assert.deepEqual(events, [
    "readiness-false",
    "http-close-start",
    "http-close-finish",
    "ws-close-start",
  ]);

  resolveWebSocketClose?.();
  assert.equal(await shutdownPromise, true);
  assert.deepEqual(events, [
    "readiness-false",
    "http-close-start",
    "http-close-finish",
    "ws-close-start",
    "ws-close-finish",
    "notification-close",
    "worker-queue-close",
    "runtime-settings-sync-close",
    "prisma-close",
    "rate-limit-stop",
    "exit-0",
  ]);
});

test("graceful shutdown is idempotent for duplicate signals", async () => {
  const events: string[] = [];
  const server = {
    close: (callback: (error?: Error) => void) => {
      events.push("http-close");
      callback();
      return server;
    },
  };
  const shutdown = createGracefulShutdownHandler(server as never, {
    markReadinessShuttingDown: () => events.push("readiness-false"),
    closeHttpServer: (httpServer) =>
      new Promise((resolve, reject) => {
        httpServer.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
    closeWorkerWebSocketServer: async () => {
      events.push("ws-close");
    },
    closeLineMessageQueueConnections: async () => {
      events.push("notification-close");
    },
    closeWorkerQueueConnections: async () => {
      events.push("worker-queue-close");
    },
    closeRuntimeSettingsSyncConnections: async () => {
      events.push("runtime-settings-sync-close");
    },
    closePrisma: async () => {
      events.push("prisma-close");
    },
    stopRateLimitCleanupTimer: () => events.push("rate-limit-stop"),
    logger: {
      info: () => undefined,
      error: () => undefined,
    },
    exit: (code) => events.push(`exit-${code}`),
    setTimeout: (() =>
      ({ unref: () => undefined }) as unknown as NodeJS.Timeout) as unknown as typeof setTimeout,
    clearTimeout: (() => undefined) as typeof clearTimeout,
    readShutdownTimeoutMs: () => 20_000,
  });

  const first = shutdown("SIGTERM");
  const second = shutdown("SIGINT");

  assert.equal(await second, false);
  assert.equal(await first, true);
  assert.equal(events.filter((event) => event === "http-close").length, 1);
  assert.equal(events.filter((event) => event === "ws-close").length, 1);
});
