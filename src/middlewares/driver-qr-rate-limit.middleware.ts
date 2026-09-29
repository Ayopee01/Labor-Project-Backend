// Import Library
import type { NextFunction, Request, Response } from "express";
// Import Utils
import { hashRefreshToken } from "../utils/refresh-token-hash";

/* -------------------------------------- Types -------------------------------------- */

// Type จำนวน request และเวลารีเซ็ตของ rate limit
type RateLimitBucket = {
  resetAt: number;
  count: number;
};

/* -------------------------------------- Config -------------------------------------- */

// Config bucket ของ rate limit การสร้าง Driver session จาก QR (แยกต่อ IP และต่อ QR token)
const ipBuckets = new Map<string, RateLimitBucket>();
const tokenBuckets = new Map<string, RateLimitBucket>();

// Function อ่านช่วงเวลาของ rate limit จาก env (default 60 วินาที)
function windowMs(): number {
  const value = Number(process.env.DRIVER_QR_RATE_LIMIT_WINDOW_MS);
  return Number.isFinite(value) && value > 0 ? value : 60000;
}

// Function อ่านจำนวน request สูงสุดต่อช่วงเวลาจาก env (default 10)
function maxRequests(): number {
  const value = Number(process.env.DRIVER_QR_RATE_LIMIT_MAX_REQUESTS);
  return Number.isFinite(value) && value > 0 ? value : 10;
}

/* -------------------------------------- Functions -------------------------------------- */

// Function หา client key จาก request (ใช้ IP address ของ client เป็น key)
function getClientIp(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

// Function ทำ HMAC fingerprint ของ QR token — ใช้เป็น rate limit key เท่านั้น ห้ามเก็บ/log token ดิบ
function fingerprintQrToken(qrToken: string): string {
  return hashRefreshToken(qrToken);
}

// Function เพิ่ม count ของ bucket แล้วคืน bucket ปัจจุบัน
function increment(
  buckets: Map<string, RateLimitBucket>,
  key: string
): RateLimitBucket {
  const now = Date.now();
  const current = buckets.get(key);
  const bucket =
    !current || current.resetAt <= now
      ? { resetAt: now + windowMs(), count: 0 }
      : current;

  bucket.count += 1;
  buckets.set(key, bucket);

  return bucket;
}

// Function จำกัดจำนวนการสร้าง Driver session จาก QR ต่อ IP และต่อ token
export function driverQrRateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const limit = maxRequests();
  const ipBucket = increment(ipBuckets, getClientIp(req));

  const qrToken =
    typeof req.body === "object" && req.body !== null
      ? (req.body as Record<string, unknown>).qr_token
      : undefined;
  const tokenBucket =
    typeof qrToken === "string" && qrToken.length > 0
      ? increment(tokenBuckets, fingerprintQrToken(qrToken))
      : null;

  if (ipBucket.count > limit || (tokenBucket && tokenBucket.count > limit)) {
    res.status(429).json({
      statusCode: 429,
      code: "DRIVER_QR_RATE_LIMITED",
      message: "Too many driver QR session requests.",
    });
    return;
  }

  next();
}

// Function สำหรับ test: ลบ bucket ทั้งหมด
export function clearDriverQrRateLimitBucketsForTest(): void {
  ipBuckets.clear();
  tokenBuckets.clear();
}
