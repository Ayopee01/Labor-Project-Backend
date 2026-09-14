// Import Library
import { Prisma } from "@prisma/client";
import type { NextFunction, Request, Response } from "express";
// Import Dependencies
import { Sentry } from "../config/sentry";
import type { ErrorLike, ErrorResponse } from "../types/shared/common.type";
// Import Utils
import ApiError from "../utils/api-error";
import { detectClientType } from "../utils/client-type";
import { logger } from "../utils/logger";

// Config mapping ของ Prisma error code ที่พบบ่อยเป็น HTTP status/code ที่ client เข้าใจได้ตรงๆ code อื่นตกไปที่ 500 เหมือนเดิม
const PRISMA_ERROR_STATUS_MAP: Record<string, { statusCode: number; code: string }> = {
  P2002: { statusCode: 409, code: "DUPLICATE_ENTRY" },
  P2025: { statusCode: 404, code: "RECORD_NOT_FOUND" },
  P2003: { statusCode: 409, code: "FOREIGN_KEY_CONSTRAINT_VIOLATION" },
};

/* -------------------------------------- Functions -------------------------------------- */

// Function จัดการ not found handler สำหรับ Express middleware
export function notFoundHandler(
  _req: Request,
  _res: Response,
  next: NextFunction
): void {
  next(new ApiError(404, "NOT_FOUND", "Route not found."));
}

// Function ตรวจสอบว่า value เป็น plain object หรือไม่ (ไม่ใช่ array, function, class instance, null, undefined)
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

// Function ตรวจสอบว่า error เป็น object ที่มี field type/statusCode/code/message/details หรือไม่
function isErrorLike(error: unknown): error is ErrorLike {
  return Boolean(error && typeof error === "object");
}

// Function normalize Prisma known error เป็น ApiError สำหรับ Express middleware
function normalizePrismaKnownError(
  error: Prisma.PrismaClientKnownRequestError
): ApiError {
  const mapped = PRISMA_ERROR_STATUS_MAP[error.code];

  if (!mapped) {
    return new ApiError(500, "INTERNAL_SERVER_ERROR", "Unexpected server error.");
  }

  return new ApiError(
    mapped.statusCode,
    mapped.code,
    "The request conflicts with existing data."
  );
}

// Function normalize unknown error เป็น ApiError สำหรับ Express middleware
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

  if (error.type === "entity.parse.failed") {
    return new ApiError(400, "VALIDATION_ERROR", "Invalid JSON body.");
  }

  // ตรวจสอบว่า error เป็น object ที่มี field statusCode/code/message/details หรือไม่ ถ้าใช่ให้สร้าง ApiError ใหม่จาก field เหล่านั้น
  const errorLike = error;
  // ตรวจสอบว่า error เป็น instance ของ Error จริงหรือไม่ (เช่น new Error() หรือ class ที่ extends Error) ถ้าไม่ใช่ให้ถือว่าเป็น object ธรรมดา
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

// Function build error response สำหรับ Express middleware โดยแปลง ApiError เป็น JSON response
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

// Function ตรวจสอบว่า error เป็น 4xx หรือไม่ ถ้าใช่ให้ include details ใน response body ถ้าไม่ใช่ (5xx) ให้ซ่อน details
function shouldIncludeErrorDetails(error: ApiError): boolean {
  return error.statusCode < 500;
}

// Function จัดการ error handler สำหรับ Express middleware โดย normalize error และ build response body
export function errorHandler(
  error: unknown,
  req: Request,
  res: Response,
  _next: NextFunction
): void {
  const normalized = normalizeError(error);
  const response = shouldIncludeErrorDetails(normalized)
    ? buildErrorResponse(normalized, req.requestId)
    : {
        statusCode: normalized.statusCode,
        code: normalized.code,
        message: "Unexpected server error.",
        requestId: req.requestId,
      };

  if (normalized.statusCode >= 500) {
    const clientType = detectClientType(req);

    // Body ผ่าน logger.error -> redact() เดิมเสมอ (mask password/token/secret ฯลฯ อัตโนมัติ) ก่อนออก log
    logger.error("Request failed.", {
      requestId: req.requestId,
      method: req.method,
      path: req.path,
      clientType,
      userId: req.auth?.account_id,
      body: req.body,
      error,
    });

    Sentry.captureException(error, {
      tags: {
        requestId: req.requestId,
        clientType,
        path: req.path,
      },
      user: req.auth?.account_id
        ? { id: String(req.auth.account_id) }
        : undefined,
    });
  }

  res.status(normalized.statusCode).json(response);
}
