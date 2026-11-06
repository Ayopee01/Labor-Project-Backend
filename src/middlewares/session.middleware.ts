// Import Library
import type { Next } from "hono";
// Import Repositories
import { findActiveById } from "../repositories/auth.repository";
import * as accountRepository from "../repositories/shared/account.repository";
import * as masterWorkerRepository from "../repositories/shared/master-worker.repository";
import * as workerSessionRepository from "../repositories/shared/worker-session.repository";
// Import Types
import { MASTER_WORKER_STATUS } from "../types/admin-workers.type";
import type { AccessTokenPayload, SessionDto } from "../types/auth.type";
import type { AppContext } from "../types/shared/http.type";
// Import Utils
import ApiError from "../utils/api-error";

/* -------------------------------------- Functions -------------------------------------- */

// Function ดึง auth payload จาก request (ไม่มี session_id/account_id throw 401)
function requireAuthPayload(c: AppContext): AccessTokenPayload {
  const auth = c.get("auth");

  if (!auth || !auth.session_id || !auth.account_id) {
    throw new ApiError(401, "INVALID_TOKEN", "Invalid or expired token.");
  }

  return auth;
}

// Function ตรวจว่า session เป็นของ account ใน token
function sessionMatchesAuth(
  session: SessionDto | null,
  auth: AccessTokenPayload
): session is SessionDto {
  return Boolean(session && session.account_id === auth.account_id);
}

// Function ตรวจ session ของ worker ว่ายัง active และ worker ยังใช้งานได้
async function resolveWorkerSession(auth: AccessTokenPayload): Promise<SessionDto> {
  const session = await workerSessionRepository.findActiveById(auth.session_id);

  if (!sessionMatchesAuth(session, auth)) {
    throw new ApiError(401, "INVALID_TOKEN", "Session is no longer active.");
  }

  const worker = await masterWorkerRepository.findById(auth.account_id);

  if (!worker || worker.status !== MASTER_WORKER_STATUS.ACTIVE) {
    throw new ApiError(401, "INVALID_TOKEN", "Account is inactive.");
  }

  return session;
}

// Function ตรวจ session ของผู้ใช้ทั่วไปว่ายัง active และ account ยังใช้งานได้
async function resolveAccountSession(auth: AccessTokenPayload): Promise<SessionDto> {
  const session = await findActiveById(auth.session_id);

  if (!sessionMatchesAuth(session, auth)) {
    throw new ApiError(401, "INVALID_TOKEN", "Session is no longer active.");
  }

  // เช็คสถานะบัญชีจริงทุก request หลัง auth token ผ่าน
  const account = await accountRepository.findById(auth.account_id);

  if (!account || account.status !== "active") {
    throw new ApiError(401, "INVALID_TOKEN", "Account is inactive.");
  }

  return session;
}

// Function ตรวจ session ของผู้ใช้ตาม role แล้วแนบให้ request
export default async function sessionMiddleware(c: AppContext, next: Next): Promise<void> {
  const auth = requireAuthPayload(c);

  c.set("session", auth.role === "worker" ? await resolveWorkerSession(auth) : await resolveAccountSession(auth));
  await next();
}
