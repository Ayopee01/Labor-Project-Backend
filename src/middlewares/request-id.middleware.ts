// Import Library
import crypto from "crypto";
import type { NextFunction, Request, Response } from "express";

/* -------------------------------------- Config -------------------------------------- */

// Config ของ request id header และ pattern ที่อนุญาตให้ใช้
const REQUEST_ID_HEADER = "x-request-id";
// Config Pattern ของ request id ที่อนุญาตให้ใช้ (ตัวอักษร A-Z, a-z, 0-9, - และ _ ความยาวไม่เกิน 128 ตัวอักษร)
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

// Function จัดการ request id middleware สำหรับ Express middleware
export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const inbound = req.header(REQUEST_ID_HEADER);
  const requestId =
    inbound && REQUEST_ID_PATTERN.test(inbound) ? inbound : crypto.randomUUID();

  req.requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);
  next();
}
