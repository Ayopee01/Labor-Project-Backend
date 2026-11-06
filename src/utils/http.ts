// Import Library
import type { ServerResponse } from "http";
import { Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
// Import Middlewares
import { formatApiResponseBody } from "../middlewares/api-case.middleware";
// Import Types
import type { AppContext, AppEnv } from "../types/shared/http.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function สร้าง router ของ app (ยอมรับ / ท้าย path เหมือนกันทุก route)
export function createRouter(): Hono<AppEnv> {
  return new Hono<AppEnv>({ strict: false });
}

// Function ตอบ JSON ตามรูปแบบ API (แปลง key เป็น PascalCase และแนบ server_time)
export function sendJson(c: AppContext, body: unknown, status = 200): Response {
  return c.json(formatApiResponseBody(c.req.path, body) as object, status as ContentfulStatusCode);
}

// Function หา IP ของ client (เชื่อ proxy 1 ชั้น: ใช้ค่าขวาสุดของ X-Forwarded-For ไม่มีจึงใช้ socket)
export function getClientIp(c: AppContext): string | undefined {
  const forwardedFor = c.req.header("x-forwarded-for")?.split(",").at(-1)?.trim();

  return forwardedFor || c.env?.incoming?.socket.remoteAddress;
}

// Function อ่าน query string (key ซ้ำเป็น array)
export function getQuery(c: AppContext): Record<string, string | string[]> {
  const query: Record<string, string | string[]> = {};

  for (const [key, values] of Object.entries(c.req.queries())) {
    query[key] = values.length === 1 ? values[0] : values;
  }

  return query;
}

// Function ดึง ServerResponse พร้อม header ที่ middleware ตั้งไว้ สำหรับ stream ที่เขียนตรง (SSE)
export function getStreamResponse(c: AppContext): ServerResponse {
  const response = c.env.outgoing as ServerResponse;

  c.res.headers.forEach((value, name) => response.setHeader(name, value));
  return response;
}
