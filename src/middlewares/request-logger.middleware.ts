// Import Library
import type { NextFunction, Request, Response } from "express";
// Import Utils
import { detectClientType } from "../utils/client-type";
import { getLogContext } from "../utils/log-context";
import { logger } from "../utils/logger";

/* -------------------------------------- Config -------------------------------------- */

// Config path ที่ไม่ต้อง log request
const SKIPPED_LOG_PATHS = new Set(["/ready"]);
// Config header ที่ใช้ระบุ version ของ client
const CLIENT_VERSION_HEADER = "x-client-version";
// Config client ที่เก็บ body ของ request ที่ไม่ผ่าน (Gate เป็นระบบภายนอก request ที่ถูกปฏิเสธไม่ถูกบันทึกที่อื่น)
const LOG_REJECTED_BODY_CLIENT_TYPES = new Set(["gate"]);
// Config เวลาที่ request ยังไม่ตอบกลับแล้วถือว่าช้าผิดปกติ ให้ส่ง Sentry (client ส่วนใหญ่ timeout ราว 20 วินาที)
const SLOW_REQUEST_ALERT_MS = 15_000;

// Function resolve log level ตาม status code ของ response
function resolveLogLevel(statusCode: number): "info" | "warn" | "error" {
  if (statusCode >= 500) {
    return "error";
  }

  if (statusCode >= 400) {
    return "warn";
  }

  return "info";
}

// Function สร้าง context สำหรับ log ของ request
export function buildRequestLogContext(input: {
  requestId?: string;
  method: string;
  path: string;
  statusCode: number;
  durationMs: number;
  clientType?: string;
  clientVersion?: string;
  userId?: number;
  ip?: string;
  errorCode?: string;
}): Record<string, unknown> {
  return {
    requestId: input.requestId,
    method: input.method,
    path: input.path,
    statusCode: input.statusCode,
    durationMs: Math.round(input.durationMs * 100) / 100,
    clientType: input.clientType,
    clientVersion: input.clientVersion,
    userId: input.userId,
    ip: input.ip,
    errorCode: input.errorCode,
  };
}

// Function log request เมื่อ response เสร็จ พร้อม status และเวลา
export function requestLoggerMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const startedAt = process.hrtime.bigint();
  // เก็บ context ของ request ไว้ตั้งแต่ต้น (service เติม TicketNumber/TicketNo ลง object เดียวกันทีหลัง)
  const logContext = getLogContext();

  // แจ้ง Sentry เมื่อ request ค้างนาน (ข้าม stream เช่น SSE ที่ส่ง header แล้วเปิดค้างโดยตั้งใจ และการอัปโหลดไฟล์ที่ช้าตามเน็ตผู้ใช้)
  const slowRequestTimer = setTimeout(() => {
    if (res.headersSent || req.is("multipart/form-data")) {
      return;
    }

    logger.error("Request is taking too long.", {
      ...logContext,
      alertCode: "SLOW_REQUEST",
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      clientType: detectClientType(req),
      userId: req.auth?.account_id,
      elapsedMs: SLOW_REQUEST_ALERT_MS,
    });
  }, SLOW_REQUEST_ALERT_MS);
  slowRequestTimer.unref();
  res.on("close", () => clearTimeout(slowRequestTimer));

  res.on("finish", () => {
    if (SKIPPED_LOG_PATHS.has(req.path)) {
      return;
    }

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const level = resolveLogLevel(res.statusCode);
    const clientType = detectClientType(req);
    // 5xx มี body อยู่ใน "Request failed." แล้ว จึงเก็บเฉพาะ 4xx
    const shouldLogBody =
      res.statusCode >= 400 && res.statusCode < 500 && LOG_REJECTED_BODY_CLIENT_TYPES.has(clientType);

    logger[level]("Request completed.", {
      ...logContext,
      errorDetails: res.locals.errorDetails,
      body: shouldLogBody ? req.body : undefined,
      ...buildRequestLogContext({
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl || req.path,
        statusCode: res.statusCode,
        durationMs,
        clientType,
        clientVersion: req.header(CLIENT_VERSION_HEADER) || undefined,
        userId: req.auth?.account_id,
        ip: req.ip,
        errorCode: res.locals.errorCode,
      }),
    }, { reportToSentry: false });
  });

  next();
}
