// Import Libraries
import type { Server } from "http";
// Import Middlewares
import { stopRateLimitCleanupTimer } from "../middlewares/security.middleware";
import { markReadinessShuttingDown } from "./readiness-state";
// Import Utils
import { logger } from "../utils/logger";

/* -------------------------------------- Types -------------------------------------- */

// Type รวม dependency ทุกตัวที่ shutdown handler ต้องใช้ แยกไว้เพื่อ inject mock ตอน test ได้
type ShutdownDependencies = {
  markReadinessShuttingDown: () => void;
  closeHttpServer: (server: Server) => Promise<void>;
  closeWorkerWebSocketServer: () => Promise<void>;
  closeLineMessageQueueConnections: () => Promise<void>;
  closeWorkerQueueConnections: () => Promise<void>;
  closeRuntimeSettingsSyncConnections: () => Promise<void>;
  // Optional เพราะเป็น housekeeping เสริม ไม่ใช่ core flow ที่ caller ทุกตัวต้องระบุ
  closeSecurityAuditLogCleanupConnections?: () => Promise<void>;
  // Optional ด้วยเหตุผลเดียวกับ closeSecurityAuditLogCleanupConnections ด้านบน
  closeHealthCheckRedisConnections?: () => Promise<void>;
  closePrisma: () => Promise<void>;
  stopRateLimitCleanupTimer: () => void;
  logger: Pick<typeof logger, "info" | "error">;
  exit: (code: number) => void;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  readShutdownTimeoutMs: () => number;
};

// Dependency ชุดจริงที่ใช้งานตอน production (ไม่ใช่ตอน test)
const defaultShutdownDependencies: ShutdownDependencies = {
  markReadinessShuttingDown,
  closeHttpServer,
  closeWorkerWebSocketServer: async () => {
    const workerSocket = await import("../websockets/worker.socket");
    await workerSocket.closeWorkerWebSocketServer();
  },
  closeLineMessageQueueConnections: async () => {
    const lineMessageQueue = await import("../queues/line-message-queue");
    await lineMessageQueue.closeLineMessageQueueConnections();
  },
  closeWorkerQueueConnections: async () => {
    const workerQueue = await import("../queues/worker-queue");
    await workerQueue.closeWorkerQueueConnections();
  },
  closeRuntimeSettingsSyncConnections: async () => {
    const runtimeSettingsSync = await import("../queues/runtime-settings-sync");
    await runtimeSettingsSync.closeRuntimeSettingsSyncConnections();
  },
  closeSecurityAuditLogCleanupConnections: async () => {
    const securityAuditLogCleanup = await import("../queues/security-audit-log-cleanup");
    await securityAuditLogCleanup.closeSecurityAuditLogCleanupConnections();
  },
  closeHealthCheckRedisConnections: async () => {
    const healthService = await import("../services/health.service");
    await healthService.closeHealthCheckRedisConnections();
  },
  closePrisma: async () => {
    const prisma = await import("../db/prisma");
    await prisma.closePrisma();
  },
  stopRateLimitCleanupTimer,
  logger,
  exit: process.exit,
  setTimeout,
  clearTimeout,
  readShutdownTimeoutMs,
};

/* -------------------------------------- Functions -------------------------------------- */

// Function อ่าน SHUTDOWN_TIMEOUT_MS จาก env 
function readShutdownTimeoutMs(): number {
  const value = Number(process.env.SHUTDOWN_TIMEOUT_MS);

  // Throw error หากไม่มีค่า SHUTDOWN_TIMEOUT_MS ใน env
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("SHUTDOWN_TIMEOUT_MS must be set to a positive number.");
  }

  return value;
}

// Function ปิด HTTP server แบบ Promise รอจน server.close() เสร็จค่อย resolve
export function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

// Function สร้าง handler จัดการ shutdown แบบเรียงลำดับ ปิดทีละส่วนจนครบแล้วค่อย exit
export function createGracefulShutdownHandler(
  server: Server,
  dependencies: ShutdownDependencies = defaultShutdownDependencies,
): (signal: NodeJS.Signals) => Promise<boolean> {
  // Flag กันเรียก shutdown ซ้ำ เผื่อได้ signal ซ้อนกัน (เช่น SIGTERM ตามด้วย SIGINT)
  let shuttingDown = false;

  return async function shutdown(signal: NodeJS.Signals): Promise<boolean> {
    if (shuttingDown) {
      return false;
    }

    shuttingDown = true;
    dependencies.markReadinessShuttingDown();
    dependencies.logger.info("Shutdown started.", { signal });

    // ตั้ง timeout สำรอง ถ้าปิดไม่เสร็จภายในเวลาที่กำหนดก็บังคับ exit กันโปรเซสค้าง
    const timeout = dependencies.setTimeout(() => {
      dependencies.logger.error("Shutdown timed out.", { signal });
      dependencies.exit(1);
    }, dependencies.readShutdownTimeoutMs());
    timeout.unref();

    let httpCloseError: unknown;

    try {
      // ต้องรอ HTTP server ปิดเสร็จ (drain in-flight request ให้จบ) ก่อนค่อยปิด WebSocket/Queue/Prisma
      // ไม่งั้น request ที่ยังทำงานอยู่จะพังกลางคันเพราะ connection ถูกตัดไปแล้ว
      await dependencies.closeHttpServer(server).catch((error) => {
        httpCloseError = error;
      });
      await dependencies.closeWorkerWebSocketServer();
      await dependencies.closeLineMessageQueueConnections();
      await dependencies.closeWorkerQueueConnections();
      await dependencies.closeRuntimeSettingsSyncConnections();
      await dependencies.closeSecurityAuditLogCleanupConnections?.();
      await dependencies.closeHealthCheckRedisConnections?.();
      await dependencies.closePrisma();
      dependencies.stopRateLimitCleanupTimer();

      if (httpCloseError) {
        throw httpCloseError;
      }

      dependencies.clearTimeout(timeout);
      dependencies.logger.info("Shutdown completed.", { signal });
      dependencies.exit(0);
    } catch (error) {
      dependencies.clearTimeout(timeout);
      dependencies.logger.error("Shutdown failed.", { signal, error });
      dependencies.exit(1);
    }

    return true;
  };
}

// Function ผูก shutdown handler เข้ากับ SIGTERM/SIGINT ครั้งเดียว (process.once)
export function registerGracefulShutdown(server: Server): void {
  const shutdown = createGracefulShutdownHandler(server);

  process.once("SIGTERM", (signal) => void shutdown(signal));
  process.once("SIGINT", (signal) => void shutdown(signal));
}
