// Import Library
import type { Request, Response } from "express";
import { ipKeyGenerator, MemoryStore, rateLimit } from "express-rate-limit";
// Import Config
import { readPositiveNumberEnv } from "../config/env";
// Import Utils
import { hashRefreshToken } from "../utils/refresh-token-hash";

/* -------------------------------------- Config -------------------------------------- */

// Config store ของ rate limit การสร้าง Driver session จาก QR (แยกต่อ IP และต่อ QR token)
const ipStore = new MemoryStore();
const tokenStore = new MemoryStore();

// Function อ่านช่วงเวลาของ rate limit จาก env (default 60 วินาที)
function windowMs(): number {
  return readPositiveNumberEnv("DRIVER_QR_RATE_LIMIT_WINDOW_MS", 60000);
}

// Function อ่านจำนวน request สูงสุดต่อช่วงเวลาจาก env (default 10)
function maxRequests(): number {
  return readPositiveNumberEnv("DRIVER_QR_RATE_LIMIT_MAX_REQUESTS", 10);
}

/* -------------------------------------- Functions -------------------------------------- */

// Function ดึง QR token จาก body (ไม่มีคืนค่าว่าง)
function getQrToken(req: Request): string {
  const qrToken =
    typeof req.body === "object" && req.body !== null
      ? (req.body as Record<string, unknown>).qr_token
      : undefined;

  return typeof qrToken === "string" ? qrToken : "";
}

// Function ทำ HMAC fingerprint ของ QR token — ใช้เป็น rate limit key เท่านั้น ห้ามเก็บ/log token ดิบ
function fingerprintQrToken(qrToken: string): string {
  return hashRefreshToken(qrToken);
}

// Function ตอบ 429 เมื่อเกินเพดาน
function sendDriverQrRateLimited(_req: Request, res: Response): void {
  res.status(429).json({
    statusCode: 429,
    code: "DRIVER_QR_RATE_LIMITED",
    message: "Too many driver QR session requests.",
  });
}

// Config middleware จำกัดจำนวนการสร้าง Driver session จาก QR ต่อ IP และต่อ token
export const driverQrRateLimitMiddleware = [
  rateLimit({
    windowMs: windowMs(),
    limit: maxRequests,
    standardHeaders: false,
    legacyHeaders: false,
    store: ipStore,
    keyGenerator: (req) => ipKeyGenerator(req.ip || req.socket.remoteAddress || "unknown"),
    handler: sendDriverQrRateLimited,
  }),
  rateLimit({
    windowMs: windowMs(),
    limit: maxRequests,
    standardHeaders: false,
    legacyHeaders: false,
    store: tokenStore,
    skip: (req) => !getQrToken(req),
    keyGenerator: (req) => fingerprintQrToken(getQrToken(req)),
    handler: sendDriverQrRateLimited,
  }),
];

// Function ลบ bucket ทั้งหมด (ใช้ใน test)
export async function clearDriverQrRateLimitBucketsForTest(): Promise<void> {
  await Promise.all([ipStore.resetAll(), tokenStore.resetAll()]);
}
