// Import Library
import { isIPv6 } from "net";
// Import Types
import type { AppContext, AppMiddleware } from "../types/shared/http.type";

/* -------------------------------------- Types -------------------------------------- */

// Type ตัวเลือกของ rate limiter
type RateLimiterOptions = {
  windowMs: number;
  limit: () => number;
  keyGenerator: (c: AppContext) => string;
  onLimited: (c: AppContext) => Response;
  skip?: (c: AppContext) => boolean;
  standardHeaders?: boolean;
};

// Type rate limiter ที่ล้าง/หยุด bucket ได้
export type RateLimiter = {
  middleware: AppMiddleware;
  reset: () => void;
  stop: () => void;
};

/* -------------------------------------- Functions -------------------------------------- */

// Function ขยาย IPv6 เป็น 8 กลุ่มเต็ม
function expandIpv6(ip: string): string[] {
  const [head, tail = ""] = ip.split("%")[0].split("::");
  const headGroups = head ? head.split(":") : [];
  const tailGroups = tail ? tail.split(":") : [];
  const zeros = Array<string>(Math.max(8 - headGroups.length - tailGroups.length, 0)).fill("0");

  return [...headGroups, ...zeros, ...tailGroups];
}

// Function แปลง IP เป็น key ของ rate limit (IPv6 รวมเป็น subnet /56 กันสลับ address หลบเพดาน)
export function toRateLimitIpKey(ip: string): string {
  if (!isIPv6(ip) || ip.includes(".")) {
    return ip.replace(/^::ffff:/i, "");
  }

  const groups = expandIpv6(ip).slice(0, 4).map((group) => group.padStart(4, "0"));

  return `${groups.slice(0, 3).join(":")}:${groups[3].slice(0, 2)}00::/56`;
}

// Function สร้าง rate limiter แบบ fixed window เก็บใน memory ของ process
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const cleanupTimer = setInterval(() => {
    const now = Date.now();

    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) {
        buckets.delete(key);
      }
    }
  }, options.windowMs);
  cleanupTimer.unref();

  const middleware: AppMiddleware = async (c, next) => {
    if (options.skip?.(c)) {
      await next();
      return;
    }

    const now = Date.now();
    const key = options.keyGenerator(c);
    const current = buckets.get(key);
    const bucket = current && current.resetAt > now ? current : { count: 0, resetAt: now + options.windowMs };
    const limit = options.limit();

    bucket.count += 1;
    buckets.set(key, bucket);

    if (options.standardHeaders) {
      c.res.headers.set("RateLimit-Policy", `${limit};w=${Math.ceil(options.windowMs / 1000)}`);
      c.res.headers.set("RateLimit-Limit", String(limit));
      c.res.headers.set("RateLimit-Remaining", String(Math.max(limit - bucket.count, 0)));
      c.res.headers.set("RateLimit-Reset", String(Math.ceil((bucket.resetAt - now) / 1000)));
    }

    if (bucket.count > limit) {
      return options.onLimited(c);
    }

    await next();
  };

  return {
    middleware,
    reset: () => buckets.clear(),
    stop: () => clearInterval(cleanupTimer),
  };
}
