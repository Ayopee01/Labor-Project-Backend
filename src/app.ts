// Import Library
import cors from "cors";
import express from "express";
// Import Docs
import setupSwagger from "./docs/swagger";
// Import Middlewares
import { normalizeApiRequestBody, pascalCaseApiResponse } from "./middlewares/api-case.middleware";
import { errorHandler, notFoundHandler } from "./middlewares/error.middleware";
import { requestIdMiddleware } from "./middlewares/request-id.middleware";
import { requestLoggerMiddleware } from "./middlewares/request-logger.middleware";
import { rateLimitMiddleware, securityHeadersMiddleware } from "./middlewares/security.middleware";
// Import Routes
import adminAuditRoutes from "./routes/admin-audit.routes";
import adminJobRoutes from "./routes/admin-jobs.routes";
import adminSettingsRoutes from "./routes/admin-settings.routes";
import adminWorkersRoutes from "./routes/admin-workers.routes";
import authRoutes from "./routes/auth.routes";
import driverRoutes from "./routes/driver.routes";
import gateRoutes from "./routes/gate.routes";
import lineRoutes from "./routes/line.routes";
import notificationRoutes from "./routes/notifications.routes";
import systemRoutes from "./routes/system.routes";
import workerRoutes from "./routes/worker.routes";

/* -------------------------------------- App -------------------------------------- */

// Config Express app
const app = express();

// Config middleware พื้นฐาน (trust proxy, request id, log, security header, rate limit)
app.set("trust proxy", 1);
app.use(requestIdMiddleware);
app.use(requestLoggerMiddleware);
app.use(securityHeadersMiddleware);
app.use(rateLimitMiddleware);

// Config CORS origin จาก env (บังคับต้องมี)
const corsOrigin = process.env.CORS_ORIGIN;

if (!corsOrigin) {
  throw new Error("CORS_ORIGIN is required.");
}

// รองรับหลาย origin คั่นด้วย comma
const corsOrigins =
  corsOrigin === "*"
    ? corsOrigin
    : corsOrigin.split(",").map((origin) => origin.trim()).filter(Boolean);

// Config CORS
app.use(
  cors({
    origin: corsOrigins,
    // ให้ browser อ่าน header เตือน token ใกล้หมดอายุได้
    exposedHeaders: ["X-Should-Refresh"],
  })
);
// Config body parser (เก็บ raw body ไว้ตรวจ signature) และแปลง case ของ request/response
app.use(
  express.json({
    verify: (req, _res, buffer) => {
      (req as express.Request).rawBody = buffer.toString("utf8");
    },
  })
);
app.use(normalizeApiRequestBody); 
app.use(pascalCaseApiResponse);

/* -------------------------------------- Routes -------------------------------------- */

app.use("/", systemRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/admin/users", adminWorkersRoutes);
app.use("/api/admin", adminAuditRoutes);
app.use("/api/admin", adminSettingsRoutes);
app.use("/api/admin", adminJobRoutes);
app.use("/api/gate", gateRoutes);
app.use("/api/driver", driverRoutes);
app.use("/api/line", lineRoutes);
app.use("/api/admin/events", notificationRoutes);
app.use("/api/workers", workerRoutes);

// Config Swagger และตัวจัดการ error
setupSwagger(app);
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
