// Import Library
import { every } from "hono/combine";
// Import Config
import { readPositiveNumberEnv } from "../config/env";
// Import Types
import type { AppContext } from "../types/shared/http.type";
// Import Utils
import { getClientIp, sendJson } from "../utils/http";
import { createRateLimiter, toRateLimitIpKey } from "../utils/rate-limiter";
import { hashRefreshToken } from "../utils/refresh-token-hash";

/* -------------------------------------- Config -------------------------------------- */

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
function getQrToken(c: AppContext): string {
  const body: unknown = c.get("body");
  const qrToken = typeof body === "object" && body !== null ? (body as Record<string, unknown>).qr_token : undefined;

  return typeof qrToken === "string" ? qrToken : "";
}

// Function ทำ HMAC fingerprint ของ QR token — ใช้เป็น rate limit key เท่านั้น ห้ามเก็บ/log token ดิบ
function fingerprintQrToken(qrToken: string): string {
  return hashRefreshToken(qrToken);
}

// Function ตอบ 429 เมื่อเกินเพดาน
function sendDriverQrRateLimited(c: AppContext): Response {
  return sendJson(
    c,
    { statusCode: 429, code: "DRIVER_QR_RATE_LIMITED", message: "Too many driver QR session requests." },
    429
  );
}

// Config limiter การสร้าง Driver session จาก QR ต่อ IP
const ipRateLimit = createRateLimiter({
  windowMs: windowMs(),
  limit: maxRequests,
  keyGenerator: (c) => toRateLimitIpKey(getClientIp(c) || "unknown"),
  onLimited: sendDriverQrRateLimited,
});

// Config limiter การสร้าง Driver session จาก QR ต่อ token
const tokenRateLimit = createRateLimiter({
  windowMs: windowMs(),
  limit: maxRequests,
  skip: (c) => !getQrToken(c),
  keyGenerator: (c) => fingerprintQrToken(getQrToken(c)),
  onLimited: sendDriverQrRateLimited,
});

// Config middleware จำกัดจำนวนการสร้าง Driver session จาก QR ต่อ IP และต่อ token
export const driverQrRateLimitMiddleware = every(ipRateLimit.middleware, tokenRateLimit.middleware);

// Function ลบ bucket ทั้งหมด (ใช้ใน test)
export async function clearDriverQrRateLimitBucketsForTest(): Promise<void> {
  ipRateLimit.reset();
  tokenRateLimit.reset();
}
