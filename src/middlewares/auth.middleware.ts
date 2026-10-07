// Import Library
import type { NextFunction, Request, Response } from "express";
// Import Utils
import { isAccessTokenNearingExpiry, verifyAccessToken } from "../utils/jwt";
import { extractBearerToken } from "../utils/bearer-token";

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจ access token และแนบ auth payload ให้ request
export default function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  try {
    const token = extractBearerToken(req.headers.authorization, {
      missingCode: "INVALID_TOKEN",
      missingMessage: "Authorization token is required.",
      invalidCode: "INVALID_TOKEN",
      invalidMessage: "Invalid authorization format.",
    });

    const payload = verifyAccessToken(token);
    req.auth = payload;

    // แค่เตือนให้ client ไป /refresh เอง (ไม่เซ็น token ใหม่ให้ที่นี่)
    if (isAccessTokenNearingExpiry(payload.exp)) {
      res.setHeader("X-Should-Refresh", "true");
    }

    next();
  } catch (error) {
    next(error);
  }
}
