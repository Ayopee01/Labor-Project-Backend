// Import Library
import type { NextFunction, Request, Response } from "express";
// Import Utils
import { hashRefreshToken } from "../utils/refresh-token-hash";

/* -------------------------------------- Types -------------------------------------- */

type RateLimitBucket = {
  resetAt: number;
  count: number;
};

/* -------------------------------------- Config -------------------------------------- */

// Rate limit เฉพาะ POST /api/driver/qr-sessions แยกจาก rateLimitMiddleware ทั่วไปของ /api/driver/* — สเปค
// 38.5 ข้อ 14 ต้องการ limit ที่เข้มกว่าเดิม ทั้งต่อ IP และต่อลายนิ้วมือของ QR token เอง กัน QR ที่หลุด
// ถูกยิงซ้ำจน DB/Redis เจอ record จำนวนมาก แม้ device slot จะเต็มแล้วก็ตาม
const ipBuckets = new Map<string, RateLimitBucket>();
const tokenBuckets = new Map<string, RateLimitBucket>();

function windowMs(): number {
  const value = Number(process.env.DRIVER_QR_RATE_LIMIT_WINDOW_MS);
  return Number.isFinite(value) && value > 0 ? value : 60000;
}

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

// Function จัดการ rate limit เฉพาะ endpoint สร้าง driver session จาก QR สำหรับ Express middleware
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
