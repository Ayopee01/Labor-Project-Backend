// Import Library
import crypto from "crypto";
import type { IncomingMessage, ServerResponse } from "http";
import type { NextFunction, Request, Response } from "express";
// Import Utils
import { getLogContext, runWithLogContext } from "../utils/log-context";

/* -------------------------------------- Config -------------------------------------- */

// Config ชื่อ header ของ request id
const REQUEST_ID_HEADER = "x-request-id";
// Config Pattern ของ request id ที่อนุญาตให้ใช้ (ตัวอักษร A-Z, a-z, 0-9, - และ _ ความยาวไม่เกิน 128 ตัวอักษร)
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// Function ใช้ request id จาก header (ถ้าถูกรูปแบบ) หรือสร้างใหม่ แล้วแนบใน response (ใช้เป็น genReqId ของ pino-http)
export function resolveRequestId(req: IncomingMessage, res: ServerResponse): string {
  const inbound = req.headers[REQUEST_ID_HEADER];
  const requestId =
    typeof inbound === "string" && REQUEST_ID_PATTERN.test(inbound) ? inbound : crypto.randomUUID();

  res.setHeader(REQUEST_ID_HEADER, requestId);
  return requestId;
}

// Function ผูก request id ที่ pino-http สร้างไว้เข้ากับ request และ log context ของ request นี้
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = String(req.id);

  req.requestId = requestId;
  runWithLogContext({ requestId }, () => {
    // เก็บ context ของ request ไว้ตั้งแต่ต้น (service เติม TicketNumber/TicketNo ลง object เดียวกันทีหลัง)
    res.locals.logContext = getLogContext();
    next();
  });
}
