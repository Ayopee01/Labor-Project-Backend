// Import Library
import type { Next } from "hono";
// Import Config
import { pinoLogger } from "../config/logger";
// Import Middlewares
import { REQUEST_ID_HEADER, resolveRequestId } from "./request-id.middleware";
// Import Types
import type { AppContext } from "../types/shared/http.type";
// Import Utils
import { detectClientType } from "../utils/client-type";
import { getClientIp } from "../utils/http";
import { getLogContext, runWithLogContext } from "../utils/log-context";
import { logger } from "../utils/logger";

/* -------------------------------------- Config -------------------------------------- */

// Config path ที่ไม่ต้อง log request (health check ที่ถูกเรียกเป็นรอบ)
const SKIPPED_LOG_PATHS = new Set(["/ready", "/livez"]);
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

// Function สร้าง object ของ log "Request completed." จาก request/response ที่จบแล้ว (ปิดบังค่า secret แล้ว)
function buildCompletedRequestLog(c: AppContext, durationMs: number): Record<string, unknown> {
  const clientType = detectClientType(c);
  const statusCode = c.res.status;
  const url = new URL(c.req.url);
  // 5xx มี body อยู่ใน "Request failed." แล้ว จึงเก็บเฉพาะ 4xx
  const shouldLogBody = statusCode >= 400 && statusCode < 500 && LOG_REJECTED_BODY_CLIENT_TYPES.has(clientType);

  return logger.redact({
    ...c.get("logContext"),
    errorDetails: c.get("errorDetails"),
    body: shouldLogBody ? c.get("body") : undefined,
    ...buildRequestLogContext({
      requestId: c.get("requestId"),
      method: c.req.method,
      path: `${url.pathname}${url.search}`,
      statusCode,
      durationMs,
      clientType,
      clientVersion: c.req.header(CLIENT_VERSION_HEADER) || undefined,
      userId: c.get("auth")?.account_id,
      ip: getClientIp(c),
      errorCode: c.get("errorCode"),
    }),
  }) as Record<string, unknown>;
}

// Function สร้าง request id, เปิด log context ของ request และ log เมื่อ response เสร็จ พร้อม status และเวลา
export async function requestLoggerMiddleware(c: AppContext, next: Next): Promise<void> {
  const requestId = resolveRequestId(c.req.header(REQUEST_ID_HEADER));
  const startedAt = performance.now();

  c.set("requestId", requestId);
  c.res.headers.set(REQUEST_ID_HEADER, requestId);

  await runWithLogContext({ requestId }, async () => {
    // เก็บ context ของ request ไว้ตั้งแต่ต้น (service เติม TicketNumber/TicketNo ลง object เดียวกันทีหลัง)
    c.set("logContext", getLogContext());
    await next();
  });

  if (!SKIPPED_LOG_PATHS.has(c.req.path)) {
    pinoLogger[resolveLogLevel(c.res.status)](
      buildCompletedRequestLog(c, performance.now() - startedAt),
      "Request completed."
    );
  }
}

// Function แจ้ง Sentry เมื่อ request ค้างนาน (ข้ามการอัปโหลดไฟล์ที่ช้าตามเน็ตผู้ใช้ ส่วน SSE จบ handler ทันทีจึงไม่เข้าเงื่อนไข)
export async function slowRequestAlertMiddleware(c: AppContext, next: Next): Promise<void> {
  const isMultipart = c.req.header("content-type")?.toLowerCase().startsWith("multipart/form-data");
  const slowRequestTimer = setTimeout(() => {
    if (isMultipart) {
      return;
    }

    logger.error("Request is taking too long.", {
      ...c.get("logContext"),
      alertCode: "SLOW_REQUEST",
      requestId: c.get("requestId"),
      method: c.req.method,
      path: c.req.path,
      clientType: detectClientType(c),
      userId: c.get("auth")?.account_id,
      elapsedMs: SLOW_REQUEST_ALERT_MS,
    });
  }, SLOW_REQUEST_ALERT_MS);
  slowRequestTimer.unref();

  try {
    await next();
  } finally {
    clearTimeout(slowRequestTimer);
  }
}
