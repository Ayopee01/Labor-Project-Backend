// Import Library
import { getRequestListener } from "@hono/node-server";
import { cors } from "hono/cors";
// Import Middlewares
import { normalizeApiRequestBody } from "./middlewares/api-case.middleware";
import { jsonBodyMiddleware } from "./middlewares/body.middleware";
import { errorHandler, notFoundHandler } from "./middlewares/error.middleware";
import { requestLoggerMiddleware, slowRequestAlertMiddleware } from "./middlewares/request-logger.middleware";
import { rateLimitMiddleware, securityHeadersMiddleware } from "./middlewares/security.middleware";
// Import Routes
import adminRoutes from "./routes/admin.routes";
import authRoutes from "./routes/auth.routes";
import driverRoutes from "./routes/driver.routes";
import gateRoutes from "./routes/gate.routes";
import lineRoutes from "./routes/line.routes";
import systemRoutes from "./routes/system.routes";
import workerRoutes from "./routes/worker.routes";
// Import Docs
import setupSwagger from "./docs/swagger";
// Import Utils
import { createRouter } from "./utils/http";

/* -------------------------------------- App -------------------------------------- */

// Config Hono app
const app = createRouter();

// Config middleware พื้นฐาน (request id, log, security header)
app.use(requestLoggerMiddleware);
app.use(slowRequestAlertMiddleware);
app.use(securityHeadersMiddleware);

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
    exposeHeaders: ["X-Should-Refresh"],
  })
);

// Config body parser และแปลง case ของ request
app.use(jsonBodyMiddleware);
app.use(normalizeApiRequestBody);
// Rate limit ต้องอยู่หลัง body parser เพื่ออ่าน username ใน body (login แยก bucket ตามบัญชี)
app.use(...rateLimitMiddleware);

/* -------------------------------------- Routes -------------------------------------- */

app.route("/", systemRoutes);
app.route("/api/auth", authRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api/gate", gateRoutes);
app.route("/api/driver", driverRoutes);
app.route("/api/line", lineRoutes);
app.route("/api/workers", workerRoutes);

// Config Swagger และ error handler
setupSwagger(app);
app.notFound(notFoundHandler);
app.onError(errorHandler);

// Config request listener ของ node:http (ws และ SSE ใช้ http.Server ตัวเดียวกัน)
export default getRequestListener(app.fetch, { overrideGlobalObjects: false });
