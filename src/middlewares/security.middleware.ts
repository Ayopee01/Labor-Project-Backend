// Import Library
import type { NextFunction, Request, Response } from "express";

/* -------------------------------------- Types -------------------------------------- */

// Type ของ bucket สำหรับเก็บข้อมูล rate limit ของ client
type RateLimitBucket = {
  resetAt: number;
  count: number;
};

/* -------------------------------------- Config -------------------------------------- */

// Map ของ client key -> bucket สำหรับเก็บข้อมูล rate limit ของ client
const buckets = new Map<string, RateLimitBucket>();
// Config ของ route patterns ที่ต้อง rate limit
const RATE_LIMITED_ROUTE_PATTERNS = [
  /^\/api\/auth\//, 
  /^\/api\/admin\//,
  /^\/api\/driver\//,
] as const;
let cleanupTimer: NodeJS.Timeout | null = null;

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจสอบว่า environment variable ที่กำหนดเป็น positive number หรือไม่ ถ้าไม่ใช่จะ throw error
function requiredPositiveNumberEnv(name: string): number {
  const value = Number(process.env[name]);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be set to a positive number.`);
  }

  return value;
}

// Function หา client key จาก request (ใช้ IP address ของ client เป็น key)
function getClientKey(req: Request): string {
  return req.ip || req.socket.remoteAddress || "unknown";
}

// Function ลบ bucket ที่หมดอายุออกจาก map
function cleanupExpiredBuckets(now = Date.now()): void {
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

// Function เพิ่ม count ของ bucket ของ client และ return bucket ใหม่
function incrementRateLimitBucket(key: string, windowMs: number): RateLimitBucket {
  const now = Date.now();
  const current = buckets.get(key);
  const bucket =
    !current || current.resetAt <= now
      ? { resetAt: now + windowMs, count: 0 }
      : current;

  bucket.count += 1;
  buckets.set(key, bucket);
  return bucket;
}

// Function สร้าง timer สำหรับ cleanup expired buckets ทุก interval ที่กำหนด
function ensureRateLimitCleanupTimer(): void {
  if (cleanupTimer) {
    return;
  }

  cleanupTimer = setInterval(
    () => cleanupExpiredBuckets(),
    requiredPositiveNumberEnv("RATE_LIMIT_CLEANUP_INTERVAL_MS")
  );
  cleanupTimer.unref();
}

// Config CSP เข้มงวดสำหรับ route ทั่วไป (ไม่มี resource ให้โหลดเลย)
const DEFAULT_CSP = "default-src 'none'; frame-ancestors 'none'";
// Config CSP ผ่อนปรนเฉพาะ /api-docs เพื่อให้ Swagger UI โหลด script/style ของตัวเองได้
const SWAGGER_CSP =
  "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'";

// Function จัดการ security headers middleware สำหรับ Express middleware
export function securityHeadersMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader("X-Content-Type-Options", "nosniff"); // ป้องกันการ sniff MIME type
  res.setHeader("X-Frame-Options", "DENY"); // ป้องกันการ clickjacking
  res.setHeader("Referrer-Policy", "no-referrer"); // ป้องกันการส่ง referrer header ไปยัง domain อื่น
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()"); // ป้องกันการเข้าถึง feature ของ browser ที่ไม่จำเป็น
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin"); // ป้องกันการโจมตีแบบ cross-origin
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains"); // บังคับให้ใช้ HTTPS Max-age 1 ปี และรวม subdomains ด้วย
  // ป้องกันการโหลด resource จาก domain อื่น และป้องกันการฝังหน้าเว็บใน iframe — /api-docs ใช้ CSP ผ่อนปรนกว่าเพราะ Swagger UI ต้องโหลด script/style ของตัวเอง
  res.setHeader("Content-Security-Policy", req.path.startsWith("/api-docs") ? SWAGGER_CSP : DEFAULT_CSP);
  next();
}

// Function จัดการ rate limit middleware สำหรับ Express middleware
export function rateLimitMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (!RATE_LIMITED_ROUTE_PATTERNS.some((pattern) => pattern.test(req.path))) {
    next();
    return;
  }

  ensureRateLimitCleanupTimer();

  const windowMs = requiredPositiveNumberEnv("RATE_LIMIT_WINDOW_MS");
  const maxRequests = requiredPositiveNumberEnv("RATE_LIMIT_MAX_REQUESTS");
  const key = getClientKey(req);
  const bucket = incrementRateLimitBucket(key, windowMs);

  res.setHeader("RateLimit-Limit", String(maxRequests));
  res.setHeader("RateLimit-Remaining", String(Math.max(0, maxRequests - bucket.count)));
  res.setHeader("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

  if (bucket.count > maxRequests) {
    res.status(429).json({
      statusCode: 429,
      code: "RATE_LIMITED",
      message: "Too many requests.",
    });
    return;
  }

  next();
}

// Function หยุด timer สำหรับ cleanup expired buckets 
export function stopRateLimitCleanupTimer(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

// Function สำหรับ test: ลบ bucket ทั้งหมด
export function clearRateLimitBuckets(): void {
  buckets.clear();
}

// Function สำหรับ test: cleanup expired buckets
export function cleanupRateLimitBucketsForTest(now = Date.now()): void {
  cleanupExpiredBuckets(now);
}

// Function สำหรับ test: return จำนวน bucket ปัจจุบัน
export function getRateLimitBucketCountForTest(): number {
  return buckets.size;
}
