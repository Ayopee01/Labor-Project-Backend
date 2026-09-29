import dotenv from "dotenv";
import { createServer } from "http";

dotenv.config({ quiet: true });

require("./src/config/sentry");

const { default: app } = require("./src/app");
const { startAssignmentTimeoutProcessing } = require("./src/queues/worker-dispatch");
const { startLineMessageWorker } = require("./src/queues/line-message-queue");
const { startRuntimeSettingsSync } = require("./src/queues/runtime-settings-sync");
const { scheduleSecurityAuditLogCleanup, startSecurityAuditLogCleanupWorker } = require("./src/queues/security-audit-log-cleanup");
const { scheduleAssignmentTimeoutSweep, startAssignmentTimeoutSweepWorker } = require("./src/queues/assignment-timeout-sweep");
const { registerGracefulShutdown } = require("./src/runtime/shutdown");
const { setupWorkerWebSocket } = require("./src/websockets/worker.socket");
const { reconcileOrphanedTicketSubmissions } = require("./src/services/shared/ticket-completion.service");
const { logger } = require("./src/utils/logger");

// ตาข่ายสุดท้ายสำหรับ Promise ที่ reject โดยไม่มีใครรับ — Node 22 ค่าเริ่มต้นจะปิด process ทั้งตัว ทำให้
// Redis/DB สะดุดครั้งเดียวใน fire-and-forget ใดๆ ล้ม API ทั้งระบบ (ถ้าตั้ง SENTRY_DSN ไว้ Sentry จะ capture ด้วย)
process.on("unhandledRejection", (reason: unknown) => {
  logger.error("Unhandled promise rejection.", { error: reason });
});

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST || "0.0.0.0";
const server = createServer(app);

startAssignmentTimeoutProcessing();
startLineMessageWorker();
startRuntimeSettingsSync();
startSecurityAuditLogCleanupWorker();
void scheduleSecurityAuditLogCleanup().catch((error: unknown) => {
  logger.error("Failed to schedule security audit log cleanup job.", { error });
});
startAssignmentTimeoutSweepWorker();
void scheduleAssignmentTimeoutSweep().catch((error: unknown) => {
  logger.error("Failed to schedule assignment timeout sweep job.", { error });
});
setupWorkerWebSocket(server);
registerGracefulShutdown(server);

server.listen(PORT, HOST, () => {
  logger.info("Server started.", { host: HOST, port: PORT });

  // Function กู้คืน Ticket ที่ค้างรอ Vendor หลัง server restart
  reconcileOrphanedTicketSubmissions()
    .then((reconciledCount: number) => {
      if (reconciledCount > 0) {
        logger.info("Reconciled orphaned ticket submissions on startup.", { reconciledCount });
      }
    })
    .catch((error: unknown) => {
      logger.error("Failed to reconcile orphaned ticket submissions on startup.", { error });
    });
});
