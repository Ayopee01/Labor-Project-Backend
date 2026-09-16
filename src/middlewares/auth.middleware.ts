// Import Library
import type { NextFunction, Request, Response } from "express";
// Import Utils
import { isAccessTokenNearingExpiry, verifyAccessToken } from "../utils/jwt";
import { extractBearerToken } from "../utils/bearer-token";

/* -------------------------------------- Functions -------------------------------------- */

// Function จัดการ auth middleware สำหรับ Express middleware
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

    // สัญญาณเตือนเฉยๆ ให้ client ไปเรียก /refresh เอง — ไม่ใช่การเซ็น token ใหม่ยัดใส่ตรงนี้ เพราะจะทำให้
    // access token ต่ออายุตัวเองได้โดยไม่ต้องพิสูจน์ว่ายังถือ refresh token จริง
    if (isAccessTokenNearingExpiry(payload.exp)) {
      res.setHeader("X-Should-Refresh", "true");
    }

    next();
  } catch (error) {
    next(error);
  }
}
