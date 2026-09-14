// Import Library
import type { NextFunction, Request, Response } from "express";
// Import Repositories
import { findActiveById } from "../repositories/auth.repository";
import * as accountRepository from "../repositories/shared/account.repository";
import * as masterWorkerRepository from "../repositories/shared/master-worker.repository";
import * as workerSessionRepository from "../repositories/shared/worker-session.repository";
// Import Utils
import ApiError from "../utils/api-error";
// Import Types
import { MASTER_WORKER_STATUS } from "../types/admin-workers.type";
import type { AccessTokenPayload, SessionDto } from "../types/auth.type";

/* -------------------------------------- Functions -------------------------------------- */

// Function require auth payload จาก request (เช็คว่า req.auth มี session_id และ account_id หรือไม่) ถ้าไม่มีก็ throw error
function requireAuthPayload(req: Request): AccessTokenPayload {
  if (!req.auth || !req.auth.session_id || !req.auth.account_id) {
    throw new ApiError(401, "INVALID_TOKEN", "Invalid or expired token.");
  }

  return req.auth;
}

// Function เช็คว่า session ตรงกับ auth payload หรือไม่ (เช็คว่า session.account_id === auth.account_id) ถ้าไม่ตรงก็ return false
function sessionMatchesAuth(
  session: SessionDto | null,
  auth: AccessTokenPayload
): session is SessionDto {
  return Boolean(session && session.account_id === auth.account_id);
}

// Function จัดการ session middleware สำหรับ worker (เช็คว่า session ตรงกับ auth payload และ worker ยัง active หรือไม่) ถ้าไม่ตรงหรือ inactive ก็ throw error
async function workerSessionMiddleware(
  req: Request,
  auth: AccessTokenPayload,
  next: NextFunction
): Promise<void> {
  const session = await workerSessionRepository.findActiveById(auth.session_id);

  if (!sessionMatchesAuth(session, auth)) {
    throw new ApiError(401, "INVALID_TOKEN", "Session is no longer active.");
  }

  const worker = await masterWorkerRepository.findById(auth.account_id);

  if (!worker || worker.status !== MASTER_WORKER_STATUS.ACTIVE) {
    throw new ApiError(401, "INVALID_TOKEN", "Account is inactive.");
  }

  req.session = session;
  next();
}

// Function จัดการ session middleware สำหรับ Express middleware (เช็คว่า session ตรงกับ auth payload และ account ยัง active หรือไม่) ถ้าไม่ตรงหรือ inactive ก็ throw error
export default async function sessionMiddleware(
  req: Request,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const auth = requireAuthPayload(req);

    if (auth.role === "worker") {
      await workerSessionMiddleware(req, auth, next);
      return;
    }

    const session = await findActiveById(auth.session_id);

    if (!sessionMatchesAuth(session, auth)) {
      throw new ApiError(401, "INVALID_TOKEN", "Session is no longer active.");
    }

    // เช็คสถานะบัญชีจริงทุก request หลัง auth token ผ่าน
    const account = await accountRepository.findById(auth.account_id);

    if (!account || account.status !== "active") {
      throw new ApiError(401, "INVALID_TOKEN", "Account is inactive.");
    }

    req.session = session;
    next();
  } catch (error) {
    next(error);
  }
}
