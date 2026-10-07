// Import Library
import type { NextFunction, Request, Response } from "express";
import { ipKeyGenerator, MemoryStore, rateLimit } from "express-rate-limit";
import helmet from "helmet";
// Import Config
import { readPositiveNumberEnv } from "../config/env";

/* -------------------------------------- Config -------------------------------------- */

// Config กลุ่ม route ที่แยก bucket rate limit (auth, driver, gate)
const RATE_LIMITED_ROUTE_GROUPS = [
  { group: "auth", pattern: /^\/api\/auth\// },
  { group: "admin", pattern: /^\/api\/admin\// },
  { group: "driver", pattern: /^\/api\/driver\// },
  { group: "gate", pattern: /^\/api\/gate\// },
  // กันเดารหัส Basic auth ของ Swagger
  { group: "docs", pattern: /^\/api-docs/ },
] as const;

// Config เพดาน login ต่อ IP (นับรวมทุก username) กันสุ่ม username ไล่เดารหัสโดยหลบ bucket ต่อบัญชี
// ตั้งสูงกว่าเพดานต่อบัญชีมาก เพราะคนงานหลายคนออกเน็ตผ่าน IP เดียวกันตอนเข้ากะ
const DEFAULT_AUTH_LOGIN_MAX_REQUESTS_PER_IP = 1000;

// Config store ของ rate limit (แยก store ต่อ limiter ตามที่ express-rate-limit บังคับ)
const routeGroupStore = new MemoryStore();
const loginIpStore = new MemoryStore();

/* -------------------------------------- Functions -------------------------------------- */

// Function หา client key จาก request (ใช้ IP address ของ client เป็น key, IPv6 รวมเป็น subnet)
function getClientKey(req: Request): string {
  return ipKeyGenerator(req.ip || req.socket.remoteAddress || "unknown");
}

// Function หากลุ่ม route ของ request (ไม่อยู่ในกลุ่มใดคืน undefined = ไม่จำกัด)
function findRouteGroup(req: Request): string | undefined {
  return RATE_LIMITED_ROUTE_GROUPS.find(({ pattern }) => pattern.test(req.path))?.group;
}

// Function ดึง username จาก body ของ route auth (ไม่มีคืนค่าว่าง)
function getAuthUsername(req: Request): string {
  if (findRouteGroup(req) !== "auth" || typeof req.body?.username !== "string") {
    return "";
  }

  return req.body.username.trim().toLowerCase();
}

// Function หา key สำหรับแยก bucket: route auth ที่มี username ใน body แยกตาม "บัญชี"
// (คนงานหลายคนที่ออกเน็ตผ่าน IP เดียวกันตอนเข้ากะจะไม่ชน bucket กัน และจำกัด brute-force ต่อบัญชีไปในตัว)
function getRateLimitKey(req: Request): string {
  const username = getAuthUsername(req);

  if (username) {
    return `auth:user:${username}`;
  }

  return `${findRouteGroup(req)}:${getClientKey(req)}`;
}

// Function ตอบ 429 เมื่อเกินเพดาน
function sendRateLimited(_req: Request, res: Response): void {
  res.status(429).json({
    statusCode: 429,
    code: "RATE_LIMITED",
    message: "Too many requests.",
  });
}

// Config option ของ helmet ที่ใช้ร่วมกัน (HSTS 1 ปีรวม subdomain, ห้าม frame, ไม่ส่ง referrer)
const BASE_HELMET_OPTIONS = {
  xFrameOptions: { action: "deny" },
  referrerPolicy: { policy: "no-referrer" },
  strictTransportSecurity: { maxAge: 31536000, includeSubDomains: true },
} as const;

// Config helmet สำหรับ route ทั่วไป (CSP ไม่มี resource ให้โหลดเลย)
const defaultHelmet = helmet({
  ...BASE_HELMET_OPTIONS,
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
});

// Config helmet เฉพาะ /api-docs (ผ่อน CSP ให้ Swagger UI โหลด script/style ของตัวเองได้)
const swaggerHelmet = helmet({
  ...BASE_HELMET_OPTIONS,
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      fontSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      frameAncestors: ["'none'"],
    },
  },
});

// Function ตั้ง security header ของทุก response
export function securityHeadersMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  // helmet ไม่มี Permissions-Policy จึงตั้งเอง (ปิด feature ของ browser ที่ไม่จำเป็น)
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  (req.path.startsWith("/api-docs") ? swaggerHelmet : defaultHelmet)(req, res, next);
}

// Config limiter ต่อกลุ่ม route (เพดานอ่านจาก env ทุก request)
const routeGroupRateLimit = rateLimit({
  windowMs: readPositiveNumberEnv("RATE_LIMIT_WINDOW_MS"),
  limit: () => readPositiveNumberEnv("RATE_LIMIT_MAX_REQUESTS"),
  standardHeaders: "draft-6",
  legacyHeaders: false,
  store: routeGroupStore,
  skip: (req) => !findRouteGroup(req),
  keyGenerator: getRateLimitKey,
  handler: sendRateLimited,
});

// Config limiter login ต่อ IP (รวมทุกบัญชี) กันเปลี่ยน username ไปเรื่อยๆ เพื่อหลบ bucket ต่อบัญชี
const loginIpRateLimit = rateLimit({
  windowMs: readPositiveNumberEnv("RATE_LIMIT_WINDOW_MS"),
  limit: () => readPositiveNumberEnv("AUTH_LOGIN_RATE_LIMIT_MAX_PER_IP", DEFAULT_AUTH_LOGIN_MAX_REQUESTS_PER_IP),
  standardHeaders: false,
  legacyHeaders: false,
  store: loginIpStore,
  skip: (req) => !getAuthUsername(req),
  keyGenerator: (req) => `auth:login-ip:${getClientKey(req)}`,
  handler: sendRateLimited,
});

// Config middleware จำกัดจำนวน request ต่อ client ตามกลุ่ม route
export const rateLimitMiddleware = [routeGroupRateLimit, loginIpRateLimit];

// Function หยุด timer ล้าง bucket ที่หมดอายุของ store
export function stopRateLimitCleanupTimer(): void {
  routeGroupStore.shutdown();
  loginIpStore.shutdown();
}

// Function ลบ bucket ทั้งหมด (ใช้ใน test)
export async function clearRateLimitBuckets(): Promise<void> {
  await Promise.all([routeGroupStore.resetAll(), loginIpStore.resetAll()]);
}
