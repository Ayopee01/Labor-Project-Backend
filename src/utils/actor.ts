import ApiError from "./api-error";

// Import Types
import type { AccessTokenPayload } from "../types/auth.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function ดึง actor ID จาก access token payload (คืน null ถ้าไม่มี)
export function getActorId(auth?: AccessTokenPayload): number | null {
  return auth?.account_id ?? null;
}

// Function ตรวจสอบและดึง actor ID ที่ต้องมีจริงใน service flow (Admin action ที่ต้อง audit)
export function requireActorId(auth?: AccessTokenPayload): number {
  const actorId = getActorId(auth);

  if (actorId === null) {
    throw new ApiError(401, "UNAUTHORIZED", "Admin actor is required.");
  }

  return actorId;
}
