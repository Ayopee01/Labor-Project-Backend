// Import Library
import type { Next } from "hono";
// Import Config
import { readPositiveNumberEnv } from "../config/env";
// Import Types
import type { AppContext } from "../types/shared/http.type";
// Import Utils
import { getClientIp, sendJson } from "../utils/http";
import { createRateLimiter, toRateLimitIpKey } from "../utils/rate-limiter";

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

/* -------------------------------------- Functions -------------------------------------- */

// Function หา client key จาก request (ใช้ IP address ของ client เป็น key, IPv6 รวมเป็น subnet)
function getClientKey(c: AppContext): string {
  return toRateLimitIpKey(getClientIp(c) || "unknown");
}

// Function หากลุ่ม route ของ request (ไม่อยู่ในกลุ่มใดคืน undefined = ไม่จำกัด)
function findRouteGroup(c: AppContext): string | undefined {
  return RATE_LIMITED_ROUTE_GROUPS.find(({ pattern }) => pattern.test(c.req.path))?.group;
}

// Function ดึง username จาก body ของ route auth (ไม่มีคืนค่าว่าง)
function getAuthUsername(c: AppContext): string {
  const username = c.get("body")?.username;

  if (findRouteGroup(c) !== "auth" || typeof username !== "string") {
    return "";
  }

  return username.trim().toLowerCase();
}

// Function หา key สำหรับแยก bucket: route auth ที่มี username ใน body แยกตาม "บัญชี"
// (คนงานหลายคนที่ออกเน็ตผ่าน IP เดียวกันตอนเข้ากะจะไม่ชน bucket กัน และจำกัด brute-force ต่อบัญชีไปในตัว)
function getRateLimitKey(c: AppContext): string {
  const username = getAuthUsername(c);

  if (username) {
    return `auth:user:${username}`;
  }

  return `${findRouteGroup(c)}:${getClientKey(c)}`;
}

// Function ตอบ 429 เมื่อเกินเพดาน
function sendRateLimited(c: AppContext): Response {
  return sendJson(c, { statusCode: 429, code: "RATE_LIMITED", message: "Too many requests." }, 429);
}

// Config security header ของทุก response (HSTS 1 ปีรวม subdomain, ห้าม frame, ไม่ส่ง referrer)
const BASE_SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["Cross-Origin-Opener-Policy", "same-origin"],
  ["Cross-Origin-Resource-Policy", "same-origin"],
  ["Origin-Agent-Cluster", "?1"],
  ["Permissions-Policy", "geolocation=(), microphone=(), camera=()"],
  ["Referrer-Policy", "no-referrer"],
  ["Strict-Transport-Security", "max-age=31536000; includeSubDomains"],
  ["X-Content-Type-Options", "nosniff"],
  ["X-DNS-Prefetch-Control", "off"],
  ["X-Download-Options", "noopen"],
  ["X-Frame-Options", "DENY"],
  ["X-Permitted-Cross-Domain-Policies", "none"],
  ["X-XSS-Protection", "0"],
];

// Config CSP สำหรับ route ทั่วไป (ไม่มี resource ให้โหลดเลย)
const DEFAULT_CONTENT_SECURITY_POLICY = "default-src 'none';frame-ancestors 'none'";

// Config CSP เฉพาะ /api-docs (ผ่อนให้ Swagger UI โหลด script/style ของตัวเองได้)
const SWAGGER_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
].join(";");

// Function ตั้ง security header ของทุก response
export async function securityHeadersMiddleware(c: AppContext, next: Next): Promise<void> {
  for (const [name, value] of BASE_SECURITY_HEADERS) {
    c.res.headers.set(name, value);
  }

  c.res.headers.set(
    "Content-Security-Policy",
    c.req.path.startsWith("/api-docs") ? SWAGGER_CONTENT_SECURITY_POLICY : DEFAULT_CONTENT_SECURITY_POLICY
  );
  await next();
}

// Config limiter ต่อกลุ่ม route (เพดานอ่านจาก env ทุก request)
const routeGroupRateLimit = createRateLimiter({
  windowMs: readPositiveNumberEnv("RATE_LIMIT_WINDOW_MS"),
  limit: () => readPositiveNumberEnv("RATE_LIMIT_MAX_REQUESTS"),
  standardHeaders: true,
  skip: (c) => !findRouteGroup(c),
  keyGenerator: getRateLimitKey,
  onLimited: sendRateLimited,
});

// Config limiter login ต่อ IP (รวมทุกบัญชี) กันเปลี่ยน username ไปเรื่อยๆ เพื่อหลบ bucket ต่อบัญชี
const loginIpRateLimit = createRateLimiter({
  windowMs: readPositiveNumberEnv("RATE_LIMIT_WINDOW_MS"),
  limit: () => readPositiveNumberEnv("AUTH_LOGIN_RATE_LIMIT_MAX_PER_IP", DEFAULT_AUTH_LOGIN_MAX_REQUESTS_PER_IP),
  skip: (c) => !getAuthUsername(c),
  keyGenerator: (c) => `auth:login-ip:${getClientKey(c)}`,
  onLimited: sendRateLimited,
});

// Config middleware จำกัดจำนวน request ต่อ client ตามกลุ่ม route
export const rateLimitMiddleware = [routeGroupRateLimit.middleware, loginIpRateLimit.middleware];

// Function หยุด timer ล้าง bucket ที่หมดอายุของ store
export function stopRateLimitCleanupTimer(): void {
  routeGroupRateLimit.stop();
  loginIpRateLimit.stop();
}

// Function ลบ bucket ทั้งหมด (ใช้ใน test)
export async function clearRateLimitBuckets(): Promise<void> {
  routeGroupRateLimit.reset();
  loginIpRateLimit.reset();
}
