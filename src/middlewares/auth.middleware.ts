// Import Library
import type { Next } from "hono";
// Import Types
import type { AppContext } from "../types/shared/http.type";
// Import Utils
import { isAccessTokenNearingExpiry, verifyAccessToken } from "../utils/jwt";
import { extractBearerToken } from "../utils/bearer-token";

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจ access token และแนบ auth payload ให้ request
export default async function authMiddleware(c: AppContext, next: Next): Promise<void> {
  const token = extractBearerToken(c.req.header("authorization"), {
    missingCode: "INVALID_TOKEN",
    missingMessage: "Authorization token is required.",
    invalidCode: "INVALID_TOKEN",
    invalidMessage: "Invalid authorization format.",
  });

  const payload = verifyAccessToken(token);
  c.set("auth", payload);

  // แค่เตือนให้ client ไป /refresh เอง (ไม่เซ็น token ใหม่ให้ที่นี่)
  if (isAccessTokenNearingExpiry(payload.exp)) {
    c.res.headers.set("X-Should-Refresh", "true");
  }

  await next();
}
