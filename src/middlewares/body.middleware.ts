// Import Library
import type { Next } from "hono";
// Import Types
import type { AppContext } from "../types/shared/http.type";
// Import Utils
import ApiError from "../utils/api-error";

/* -------------------------------------- Config -------------------------------------- */

// Config ขนาด JSON body สูงสุด (100KB)
const JSON_BODY_LIMIT_BYTES = 100 * 1024;
// Config path ที่ต้องเก็บ raw body ไว้ตรวจ signature (route อื่นไม่ต้องกิน memory ซ้ำ)
const RAW_BODY_PATHS = new Set(["/api/line/webhook"]);

/* -------------------------------------- Functions -------------------------------------- */

// Function สร้าง error เมื่อ body ใหญ่เกินเพดาน
function payloadTooLargeError(): ApiError {
  return new ApiError(413, "PAYLOAD_TOO_LARGE", "Request body is too large.");
}

// Function parse JSON body (รับเฉพาะ object/array)
function parseJsonBody(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);

    if (parsed !== null && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    // ตกไป throw ด้านล่างเหมือน JSON ที่ไม่ใช่ object/array
  }

  throw new ApiError(400, "VALIDATION_ERROR", "Invalid JSON body.");
}

// Function อ่าน JSON body ของ request ลง context (เก็บ raw body ของ path ที่ต้องตรวจ signature)
export async function jsonBodyMiddleware(c: AppContext, next: Next): Promise<void> {
  const contentType = c.req.header("content-type")?.split(";")[0].trim().toLowerCase();

  if (contentType !== "application/json") {
    await next();
    return;
  }

  if (Number(c.req.header("content-length") ?? 0) > JSON_BODY_LIMIT_BYTES) {
    throw payloadTooLargeError();
  }

  const text = await c.req.text();

  if (Buffer.byteLength(text) > JSON_BODY_LIMIT_BYTES) {
    throw payloadTooLargeError();
  }

  if (text) {
    if (RAW_BODY_PATHS.has(c.req.path)) {
      c.set("rawBody", text);
    }

    c.set("body", parseJsonBody(text));
  } else if (c.req.header("content-length") !== undefined) {
    c.set("body", {});
  }

  await next();
}
