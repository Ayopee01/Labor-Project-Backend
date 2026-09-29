// Import Types
import type { AccessTokenPayload } from "../types/auth.type";
// Import Utils
import ApiError from "./api-error";

/* -------------------------------------- Functions -------------------------------------- */

// Function ดึง actor ID จาก access token payload (คืน null ถ้าไม่มี)
export function getActorId(auth?: AccessTokenPayload): number | null {
  return auth?.account_id ?? null;
}

// Function ดึง actor ID ที่ต้องมี ถ้าไม่มีให้ throw 401 (ใช้กับ Admin action ที่ต้อง audit)
export function requireActorId(auth?: AccessTokenPayload): number {
  const actorId = getActorId(auth);

  if (actorId === null) {
    throw new ApiError(401, "UNAUTHORIZED", "Admin actor is required.");
  }

  return actorId;
}
