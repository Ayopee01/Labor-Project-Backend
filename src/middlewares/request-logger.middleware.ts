// Import Library
import type { NextFunction, Request, Response } from "express";
// Import Utils
import { detectClientType } from "../utils/client-type";
import { logger } from "../utils/logger";

/* -------------------------------------- Config -------------------------------------- */

// Config ของ path ที่ไม่ต้อง log request
const SKIPPED_LOG_PATHS = new Set(["/ready"]);
// Config ของ header ที่ใช้ระบุ version ของ client
const CLIENT_VERSION_HEADER = "x-client-version";

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
  };
}

// Function จัดการ request logger middleware สำหรับ Express middleware
export function requestLoggerMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const startedAt = process.hrtime.bigint();

  res.on("finish", () => {
    if (SKIPPED_LOG_PATHS.has(req.path)) {
      return;
    }

    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
    const level = resolveLogLevel(res.statusCode);

    logger[level](
      "Request completed.",
      buildRequestLogContext({
        requestId: req.requestId,
        method: req.method,
        path: req.originalUrl || req.path,
        statusCode: res.statusCode,
        durationMs,
        clientType: detectClientType(req),
        clientVersion: req.header(CLIENT_VERSION_HEADER) || undefined,
        userId: req.auth?.account_id,
        ip: req.ip,
      }),
    );
  });

  next();
}
