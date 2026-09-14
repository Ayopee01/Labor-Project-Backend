// Import Dependencies
import cors from "cors";
import express from "express";

// Import
import setupSwagger from "./docs/swagger";
import { normalizeApiRequestBody, pascalCaseApiResponse } from "./middlewares/api-case.middleware";
import { errorHandler, notFoundHandler } from "./middlewares/error.middleware";
import { requestIdMiddleware } from "./middlewares/request-id.middleware";
import { requestLoggerMiddleware } from "./middlewares/request-logger.middleware";
import { rateLimitMiddleware, securityHeadersMiddleware } from "./middlewares/security.middleware";
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

const app = express();

app.set("trust proxy", 1); // trust first proxy
app.use(requestIdMiddleware); // Add requestId to each request for logging and tracing
app.use(requestLoggerMiddleware); // Log each request
app.use(securityHeadersMiddleware); // Set security headers
app.use(rateLimitMiddleware); // Apply rate limiting

// ใช้ CORS_ORIGIN จาก env
const corsOrigin = process.env.CORS_ORIGIN;

// Throw error ถ้าไม่มี CORS_ORIGIN ใน env
if (!corsOrigin) {
  throw new Error("CORS_ORIGIN is required.");
}

// CORS Configuration
app.use(
  cors({
    origin: corsOrigin,
  })
);
// Body Parser Configuration
app.use(
  express.json({
    verify: (req, _res, buffer) => {
      (req as express.Request).rawBody = buffer.toString("utf8");
    },
  })
);
app.use(normalizeApiRequestBody); 
app.use(pascalCaseApiResponse);

// Routes
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

// Swagger Setup
setupSwagger(app);

// Error Handling
app.use(notFoundHandler);
app.use(errorHandler);

// Export
export default app;
