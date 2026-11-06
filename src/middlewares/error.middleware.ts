// Import Library
import { Prisma } from "@prisma/client";
// Import Types
import type { ErrorLike, ErrorResponse } from "../types/shared/common.type";
import type { AppContext } from "../types/shared/http.type";
// Import Utils
import ApiError from "../utils/api-error";
import { detectClientType } from "../utils/client-type";
import { sendJson } from "../utils/http";
import { logger } from "../utils/logger";

// Config แปลง Prisma error code ที่พบบ่อยเป็น HTTP status/code (code อื่นเป็น 500)
const PRISMA_ERROR_STATUS_MAP: Record<string, { statusCode: number; code: string }> = {
  P2002: { statusCode: 409, code: "DUPLICATE_ENTRY" },
  P2025: { statusCode: 404, code: "RECORD_NOT_FOUND" },
  P2003: { statusCode: 409, code: "FOREIGN_KEY_CONSTRAINT_VIOLATION" },
  P2028: { statusCode: 409, code: "TRANSACTION_CONFLICT" },
  P2034: { statusCode: 409, code: "TRANSACTION_CONFLICT" },
};

// Config error 4xx ที่แปลว่าข้อมูลตั้งค่าของระบบไม่ครบ (ไม่ใช่ผู้ใช้ส่งผิด) ให้ส่ง Sentry ไว้แก้ข้อมูล
const CONFIGURATION_ERROR_CODES = new Set(["MARKET_NAME_NOT_CONFIGURED"]);

// Config ข้อความของ error ที่เกิดจากรอ lock นานหรือ deadlock (ให้ client ลองใหม่)
const TRANSACTION_CONFLICT_MESSAGE = "The data is being updated by another request. Please try again.";

/* -------------------------------------- Functions -------------------------------------- */

// Function ตอบ 404 เมื่อไม่พบ route
export function notFoundHandler(c: AppContext): Response {
  return errorHandler(new ApiError(404, "NOT_FOUND", "Route not found."), c);
}

// Function ตรวจว่า value เป็น plain object (ไม่ใช่ array, class instance หรือ null)
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// Function ตรวจสอบว่า error เป็น object ที่มี field type/statusCode/code/message/details หรือไม่
function isErrorLike(error: unknown): error is ErrorLike {
  return Boolean(error && typeof error === "object");
}

// Function แปลง Prisma known error เป็น ApiError
function normalizePrismaKnownError(
  error: Prisma.PrismaClientKnownRequestError
): ApiError {
  // deadlock ที่ Postgres ตรวจเจอใน raw query (เช่น SELECT ... FOR UPDATE) มาเป็น P2010 พร้อมรหัส 40P01
  const isRawDeadlock = error.code === "P2010" && JSON.stringify(error.meta ?? {}).includes("40P01");
  const mapped = isRawDeadlock
    ? PRISMA_ERROR_STATUS_MAP.P2034
    : PRISMA_ERROR_STATUS_MAP[error.code];

  if (!mapped) {
    return new ApiError(500, "INTERNAL_SERVER_ERROR", "Unexpected server error.");
  }

  return new ApiError(
    mapped.statusCode,
    mapped.code,
    mapped.code === "TRANSACTION_CONFLICT"
      ? TRANSACTION_CONFLICT_MESSAGE
      : "The request conflicts with existing data."
  );
}

// Function แปลง error ทุกแบบเป็น ApiError
function normalizeError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return normalizePrismaKnownError(error);
  }

  if (!isErrorLike(error)) {
    return new ApiError(
      500,
      "INTERNAL_SERVER_ERROR",
      "Unexpected server error."
    );
  }

  // error ที่มี statusCode/code/message ให้สร้าง ApiError จาก field เหล่านั้น
  const errorLike = error;
  // แยก Error จริงออกจาก object ธรรมดา
  const isRealErrorInstance = error instanceof Error;

  if (
    isRealErrorInstance &&
    errorLike.statusCode &&
    errorLike.code &&
    errorLike.message
  ) {
    return new ApiError(
      errorLike.statusCode,
      errorLike.code,
      errorLike.message,
      errorLike.details
    );
  }

  return new ApiError(
    500,
    "INTERNAL_SERVER_ERROR",
    "Unexpected server error."
  );
}

// Function สร้าง JSON response จาก ApiError
function buildErrorResponse(error: ApiError, requestId?: string): ErrorResponse {
  const response: ErrorResponse = {
    statusCode: error.statusCode,
    code: error.code,
    message: error.message,
    requestId,
  };

  if (!error.details) {
    return response;
  }

  if (isPlainObject(error.details)) {
    Object.assign(response, error.details);
    return response;
  }

  response.details = error.details;
  return response;
}

// Function ตรวจว่าแนบ details ได้หรือไม่ (เฉพาะ 4xx ส่วน 5xx ซ่อนไว้)
function shouldIncludeErrorDetails(error: ApiError): boolean {
  return error.statusCode < 500;
}

// Function แปลง error ทุกแบบเป็น JSON response (5xx ส่ง Sentry)
export function errorHandler(error: unknown, c: AppContext): Response {
  const normalized = normalizeError(error);
  const requestId = c.get("requestId");
  const response = shouldIncludeErrorDetails(normalized)
    ? buildErrorResponse(normalized, requestId)
    : {
        statusCode: normalized.statusCode,
        code: normalized.code,
        message: "Unexpected server error.",
        requestId,
      };

  // ให้ request log บันทึก error code และรายละเอียด (ค้น 4xx เช่น TICKET_NO_ALREADY_EXISTS ได้)
  // constraint ของ DB (เช่น DUPLICATE_ENTRY) เก็บ Prisma code/meta ไว้ด้วย ไม่งั้นไม่รู้ว่าชน constraint ไหน
  c.set("errorCode", normalized.code);
  c.set(
    "errorDetails",
    !shouldIncludeErrorDetails(normalized)
      ? undefined
      : error instanceof Prisma.PrismaClientKnownRequestError
        ? { prismaCode: error.code, meta: error.meta }
        : normalized.details
  );

  if (normalized.statusCode >= 500) {
    // Body ผ่าน redact() ก่อนออก log เสมอ ส่วน Sentry ได้จาก logger.error พร้อม tag โดยไม่มี body
    logger.error("Request failed.", {
      requestId,
      method: c.req.method,
      path: c.req.path,
      clientType: detectClientType(c),
      userId: c.get("auth")?.account_id,
      body: c.get("body"),
      error,
    });
  } else if (CONFIGURATION_ERROR_CODES.has(normalized.code)) {
    logger.error(`Request rejected because of missing configuration: ${normalized.code}.`, {
      requestId,
      method: c.req.method,
      path: c.req.path,
      clientType: detectClientType(c),
      alertCode: normalized.code,
      details: normalized.details,
    });
  }

  return sendJson(c, response, normalized.statusCode);
}
