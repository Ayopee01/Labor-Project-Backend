// Import Library
import dotenv from "dotenv";
import { createServer } from "http";

dotenv.config({ quiet: true });

const { Sentry } = require("./src/config/sentry");

const { default: app } = require("./src/app");
const { startAssignmentTimeoutProcessing } = require("./src/queues/worker-dispatch");
const { startLineMessageWorker } = require("./src/queues/line-message-queue");
const { scheduleMaintenanceJobs, startMaintenanceWorker } = require("./src/queues/maintenance-queue");
const { startRuntimeSettingsSync } = require("./src/queues/runtime-settings-sync");
const { registerGracefulShutdown } = require("./src/runtime/shutdown");
const { setupWorkerWebSocket } = require("./src/websockets/worker.socket");
const { reconcileOrphanedTicketSubmissions } = require("./src/services/shared/ticket-completion.service");
const { syncPendingWorkerImages } = require("./src/services/shared/worker-image.service");
const { logger } = require("./src/utils/logger");

// ดัก Promise reject ที่ไม่มีใครรับ กัน Node ปิด process ทั้งตัว (logger.error ส่ง Sentry ให้ถ้าตั้ง SENTRY_DSN)
process.on("unhandledRejection", (reason: unknown) => {
  logger.error("Unhandled promise rejection.", { error: reason });
});

// ดัก exception ที่ไม่มีใครรับ บันทึก log/Sentry ให้ครบก่อนปิด process (สถานะในหน่วยความจำไม่น่าเชื่อถือแล้ว)
process.on("uncaughtException", (error: unknown) => {
  logger.error("Uncaught exception. Shutting down.", { error });
  void Sentry.flush(2000).finally(() => process.exit(1));
});

// Config host และ port ที่ HTTP server ฟัง
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST || "0.0.0.0";
const server = createServer(app);

// Config timeout ของ HTTP server กัน request ค้างคิวจน client timeout เอง (fail fast ตอนโหลดพุ่ง)
server.requestTimeout = 20000; // ตัด client ที่ส่ง request (header+body) ไม่ครบใน 20 วินาที ไม่ได้ตัดการประมวลผลที่ช้า
server.headersTimeout = 15000; // ตัด client ที่ส่ง header ช้าผิดปกติ
server.keepAliveTimeout = 10000; // ปิด idle keep-alive connection ที่ไม่มี request ต่อ

startAssignmentTimeoutProcessing();
startLineMessageWorker();
startRuntimeSettingsSync();
startMaintenanceWorker();
void scheduleMaintenanceJobs().catch((error: unknown) => {
  logger.error("Failed to schedule maintenance jobs.", { error });
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

  // อัปโหลดรูป Worker ที่ค้างขึ้น Spaces เบื้องหลัง (ยังไม่ตั้งค่า Spaces = ข้าม) เพื่อให้ API คืน ImageUrl ได้
  syncPendingWorkerImages()
    .then((summary: { spaces_configured: boolean; total: number; uploaded: number; failed: number }) => {
      if (summary.spaces_configured && summary.total > 0) {
        logger.info("Synced pending worker images on startup.", { summary });
      }
    })
    .catch((error: unknown) => {
      logger.error("Failed to sync pending worker images on startup.", { error });
    });
});
