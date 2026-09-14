// Import Repositories
import { createPending, findActiveById, findByUsername, revoke, updateRefreshTokenHash } from "../repositories/auth.repository";
import * as accountRepository from "../repositories/shared/account.repository";
import * as sessionRepository from "../repositories/shared/session.repository";
import * as masterWorkerRepository from "../repositories/shared/master-worker.repository";
import * as workerSessionRepository from "../repositories/shared/worker-session.repository";
// Import Queues
import { getWorkerQueueStatus } from "../queues/worker-queue";
// Import Config
import { AUTH_DEFAULTS, getAccessTokenExpiresInSeconds } from "../config/auth.config";
import { EMPTY_SECURITY_AUDIT_CONTEXT } from "../config/security-audit.config";
// Import Services
import { getAccountPermissions } from "./shared/account-permission.service";
import { performWorkerOfflineCascade } from "./worker.service";
import { registerWorkerPushToken as registerWorkerPushTokenForSession, registerWorkerPushTokenForAccount, revokeWorkerPushTokensBySession, sendWorkerPushNotificationToSession } from "./shared/worker-push.service";
import { diffChangedFields, writeSecurityAuditLog, writeSecurityAuditLogBestEffort } from "./shared/security-audit-log.service";
// Import Utils
import { disconnectWorkerSocket, sendWorkerSocketEvent } from "../websockets/worker.socket";
// Import Config
import { deleteAdminProfileImageByUrl } from "../config/spaces";
import { withTransaction } from "../db/prisma";
// Import Types
import { SECURITY_AUDIT_EVENT_TYPE, SECURITY_AUDIT_OUTCOME } from "../types/shared/security-audit-log.type";
import type { AccessTokenPayload, AuthSuccessResponse, AuthTokens, MeResponse, ProfileCardShift, SessionDto, UpdateLangResponse } from "../types/auth.type";
import type { DbConnection } from "../types/shared/common.type";
import { MASTER_WORKER_STATUS } from "../types/admin-workers.type";
import type { AccountDto, MasterWorkerDto } from "../types/admin-workers.type";
import { WORKER_WORK_STATUS } from "../types/shared/worker-status.type";
import type { SecurityAuditRequestContext } from "../types/shared/security-audit-log.type";
// Import Validation
import { parseWithSchema } from "../validation/parser";
import { changeOwnPasswordBodySchema, confirmForceLoginBodySchema, loginBodySchema, refreshBodySchema, updateOwnLangBodySchema, updateOwnProfileBodySchema } from "../validation/schemas";
// Import Utils
import ApiError from "../utils/api-error";
import { signAccessToken, signLoginChallengeToken, signRefreshToken, verifyLoginChallengeToken, verifyRefreshToken } from "../utils/jwt";
import { logger } from "../utils/logger";
import { hashPassword, verifyPassword } from "../utils/password";
import { hashRefreshToken, refreshTokenHashesMatch } from "../utils/refresh-token-hash";
import { formatScheduleWithShift } from "../utils/shift";

/* -------------------------------------- Config -------------------------------------- */

const WORKER_ROLE = "worker";

const ADMIN_SESSION_DEVICE_NAME = "Admin Web";

// Hash หลอกสำหรับให้ argon2.verify ทำงานเสมอแม้ไม่พบ account/worker กัน timing attack ที่แยกได้ว่า
// identifier มีอยู่จริงหรือไม่จากเวลาตอบสนอง — compute ครั้งเดียวตอน module โหลด
const dummyPasswordHashPromise = hashPassword(
  "dummy-password-for-constant-time-login-check"
);

/* -------------------------------------- Admin (Account) helpers -------------------------------------- */

// Function ดึง account ที่ต้อง active จริงตาม ID ใช้ร่วมกันทุก flow ที่ต้องเช็คสถานะก่อนทำงานต่อ —
// pre-auth flow โยน 423 ACCOUNT_INACTIVE, self-service flow โยน 401 INVALID_TOKEN เพื่อไม่ให้รู้ว่า account มีอยู่จริง
async function requireActiveAccountById(
  accountId: number,
  statusCode: number,
  errorCode: string,
  errorMessage: string
): Promise<AccountDto> {
  const account = await accountRepository.findById(accountId);

  if (!account || account.status !== "active") {
    throw new ApiError(statusCode, errorCode, errorMessage);
  }

  return account;
}

// Function ดึง worker ที่ต้อง active จริงตาม ID — คู่ขนานของ requireActiveAccountById ฝั่ง Admin
async function requireActiveWorkerById(
  workerId: number,
  statusCode: number,
  errorCode: string,
  errorMessage: string
): Promise<MasterWorkerDto> {
  const worker = await masterWorkerRepository.findById(workerId);

  if (!worker || worker.status !== MASTER_WORKER_STATUS.ACTIVE) {
    throw new ApiError(statusCode, errorCode, errorMessage);
  }

  return worker;
}

// Function สร้าง admin employee code ใน service flow
function buildAdminEmployeeCode(accountId: number): string {
  return `ADM${String(accountId).padStart(4, "0")}`;
}

// Function จัดรูปแบบ profile card shift ใน service flow
function formatProfileCardShift(
  schedule: ReturnType<typeof formatScheduleWithShift>
): ProfileCardShift | null {
  if (!schedule) {
    return null;
  }

  return {
    name: schedule.shift_name,
    start_time: schedule.time_in,
    end_time: schedule.time_out,
  };
}

// Function สร้าง me response ของ Admin ใน service flow
async function buildAdminMeResponse(
  account: AccountDto,
  currentSession?: SessionDto | null
): Promise<MeResponse> {
  const latestSession = currentSession ?? (await sessionRepository.findActiveByAccountId(account.id));
  const latestActiveAt = latestSession?.last_active_at ?? null;
  const accountPermissions = await getAccountPermissions(account);
  const employeeCode = buildAdminEmployeeCode(account.id);

  return {
    role: "admin",
    full_name: account.full_name,
    employee_code: employeeCode,
    position: account.position,
    admin_code: employeeCode,
    status: account.status,
    email: account.email,
    phone: account.phone,
    // ต้องเป็น null เสมอเมื่อยังไม่มีรูป ห้ามละ field ทิ้ง เพื่อให้ Frontend แยกจาก response รุ่นเก่าที่ไม่มี field นี้ได้
    image_url: account.image_url ?? null,
    permission_level: account.permission_level,
    permissions: accountPermissions.permissions,
    lang: account.lang,
    latest_active_at: latestActiveAt,
  };
}

// Function สร้าง me response ของ Worker ใน service flow
function buildWorkerMeResponse(worker: MasterWorkerDto): MeResponse {
  const schedule = formatScheduleWithShift(
    worker.time_work !== null && worker.time_in !== null && worker.time_out !== null
      ? {
          id: worker.id,
          worker_id: worker.id,
          time_work: worker.time_work,
          work_date: worker.work_start_date ?? worker.created_at.slice(0, 10),
          time_in: worker.time_in,
          time_out: worker.time_out,
          is_current: true,
          created_by: null,
          updated_by: null,
          created_at: worker.created_at,
          updated_at: worker.updated_at,
        }
      : null
  );

  return {
    role: "worker",
    full_name: worker.full_name,
    worker_code: worker.labor_code,
    nationality: worker.nationality,
    shirt_type: worker.labor_color,
    shirt_number: worker.coat_no,
    work_start_date: worker.work_start_date,
    phone: worker.telephone,
    lang: worker.lang,
    shift: formatProfileCardShift(schedule),
  };
}

// Function ตรวจสอบและดึง worker device ใน service flow
function requireWorkerDevice(
  deviceId?: string,
  deviceName?: string
): { deviceId: string; deviceName: string } {
  if (!deviceId || !deviceName) {
    const validationErrors = [];

    if (!deviceId) {
      validationErrors.push({
        field: "device_id",
        message: "Required.",
      });
    }

    if (!deviceName) {
      validationErrors.push({
        field: "device_name",
        message: "Required.",
      });
    }

    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      "Device information is required for worker login.",
      {
        validation_errors: validationErrors,
      }
    );
  }

  return {
    deviceId,
    deviceName,
  };
}

// Function เช็คว่า Active Session ของ Worker (ถ้ามี) เป็นอุปกรณ์เดียวกับที่กำลัง Login หรือไม่ โยน 409
// พร้อม Login Challenge Token ถ้าคนละอุปกรณ์ — เรียกทั้งนอก Transaction (fail-fast) และในนั้นหลังล็อกแถว (กัน race จริง)
function assertNoConflictingWorkerSession(
  workerId: number,
  activeSession: SessionDto | null,
  sessionDevice: { deviceId: string; deviceName: string }
): void {
  if (!activeSession || activeSession.device_id === sessionDevice.deviceId) {
    return;
  }

  const loginChallengeToken = signLoginChallengeToken({
    account_id: workerId,
    role: WORKER_ROLE,
    old_session_id: activeSession.id,
    new_device_id: sessionDevice.deviceId,
  });

  throw new ApiError(
    409,
    "ACTIVE_SESSION_EXISTS",
    "Another active session exists.",
    {
      login_challenge_token: loginChallengeToken,
      active_device: {
        device_id: activeSession.device_id,
        device_name: activeSession.device_name,
        last_active_at: activeSession.last_active_at,
      },
    }
  );
}

// Function สร้าง admin session ใน service flow
async function createAdminSession(
  account: AccountDto,
  deviceId: string,
  deviceName: string,
  connection: DbConnection
): Promise<AuthTokens> {
  const expiresAt = new Date(
    Date.now() + AUTH_DEFAULTS.sessionExpiresInMilliseconds
  ).toISOString();
  const session = await createPending(
    {
      account_id: account.id,
      device_id: deviceId,
      device_name: deviceName,
      expires_at: expiresAt,
    },
    connection
  );
  const accountPermissions = await getAccountPermissions(account);
  const accessToken = signAccessToken({
    account_id: account.id,
    role: account.role,
    permission_level: account.permission_level,
    permissions: accountPermissions.permissions,
    session_id: session.id,
  });
  const refreshToken = signRefreshToken({
    account_id: account.id,
    role: account.role,
    session_id: session.id,
  });

  await updateRefreshTokenHash(
    session.id,
    hashRefreshToken(refreshToken),
    session.refresh_token_hash,
    connection
  );

  return {
    accessToken,
    refreshToken,
    session,
  };
}

// Function สร้าง worker session ใน service flow — คู่ขนานของ createAdminSession แต่เขียนลง worker_sessions และไม่มี permission ให้ query
async function createWorkerSession(
  worker: MasterWorkerDto,
  deviceId: string,
  deviceName: string,
  connection: DbConnection
): Promise<AuthTokens> {
  const expiresAt = new Date(
    Date.now() + AUTH_DEFAULTS.sessionExpiresInMilliseconds
  ).toISOString();
  const session = await workerSessionRepository.createPending(
    {
      account_id: worker.id,
      device_id: deviceId,
      device_name: deviceName,
      expires_at: expiresAt,
    },
    connection
  );
  const accessToken = signAccessToken({
    account_id: worker.id,
    role: WORKER_ROLE,
    permission_level: null,
    permissions: [],
    session_id: session.id,
  });
  const refreshToken = signRefreshToken({
    account_id: worker.id,
    role: WORKER_ROLE,
    session_id: session.id,
  });

  await workerSessionRepository.updateRefreshTokenHash(
    session.id,
    hashRefreshToken(refreshToken),
    session.refresh_token_hash,
    connection
  );

  return {
    accessToken,
    refreshToken,
    session,
  };
}

// Function สร้าง auth success response ใน service flow
async function buildAuthSuccessResponse(
  tokens: AuthTokens
): Promise<AuthSuccessResponse> {
  return {
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken,
    token_type: "Bearer",
    expires_in: getAccessTokenExpiresInSeconds(),
  };
}

/* -------------------------------------- Functions -------------------------------------- */

// Function จัดการ login — dispatch ไปหา Account (Admin) หรือ MasterWorker (Worker login ด้วย LaborCode
// เป็น username) ต้องเรียก verifyPassword เสมอไม่ว่าจะเจอ identity ฝั่งไหนหรือไม่เจอเลย เพื่อกัน timing-based username enumeration
export async function login(
  body: unknown,
  context: SecurityAuditRequestContext = EMPTY_SECURITY_AUDIT_CONTEXT
) {
  const {
    username,
    password,
    device_id: deviceId,
    device_name: deviceName,
    fcm_token: fcmToken,
    platform,
  } = parseWithSchema(loginBodySchema, body);
  // เรียก findByUsername และ findByLaborCode พร้อมกันเสมอ (ไม่ query แบบ fallback ทีละขั้น) เพื่อไม่ให้
  // เวลาตอบสนองต่างกันระหว่าง username ที่เป็น Admin กับไม่ใช่ ซึ่งจะเป็นช่องทาง timing enumeration ใหม่
  const [account, workerLookup] = await Promise.all([
    findByUsername(username),
    masterWorkerRepository.findByLaborCode(username),
  ]);
  const worker = account ? null : workerLookup;
  const passwordHash =
    account?.password_hash ?? worker?.password_hash ?? (await dummyPasswordHashPromise);
  const passwordValid = await verifyPassword(password, passwordHash);

  if ((!account && !worker) || !passwordValid) {
    // Fire-and-forget (ไม่ await) เพื่อไม่ให้เวลาตอบสนองของ 401 ขึ้นกับเวลาเขียน log — ทั้งสอง branch
    // (username ไม่มี / password ผิด) เขียน log และคืน response ข้อความเดียวกันเสมอ ไม่เปิดช่อง username enumeration
    void writeSecurityAuditLogBestEffort({
      event_type: SECURITY_AUDIT_EVENT_TYPE.AUTH_LOGIN_FAILED,
      outcome: SECURITY_AUDIT_OUTCOME.FAILURE,
      actor_type: account ? "admin" : worker ? "worker" : null,
      actor_account_id: account?.id ?? null,
      actor_worker_id: worker?.id ?? null,
      actor_username: account?.username ?? worker?.labor_code ?? username,
      actor_full_name: account?.full_name ?? worker?.full_name ?? null,
      failure_code: !account && !worker ? "unknown_username" : "invalid_password",
      ip_address: context.ip_address,
      user_agent: context.user_agent,
      request_id: context.request_id,
    });

    throw new ApiError(
      401,
      "INVALID_CREDENTIALS",
      "Invalid username or password."
    );
  }

  if (account) {
    if (account.status !== "active") {
      void writeSecurityAuditLogBestEffort({
        event_type: SECURITY_AUDIT_EVENT_TYPE.AUTH_LOGIN_FAILED,
        outcome: SECURITY_AUDIT_OUTCOME.FAILURE,
        actor_type: "admin",
        actor_account_id: account.id,
        actor_username: account.username,
        actor_full_name: account.full_name,
        failure_code: "account_inactive",
        ip_address: context.ip_address,
        user_agent: context.user_agent,
        request_id: context.request_id,
      });

      throw new ApiError(423, "ACCOUNT_INACTIVE", "Account is inactive.");
    }

    // Admin ตั้งใจให้มี session เดียวเสมอ ไม่แยกตามอุปกรณ์เหมือน Worker — device_id/device_name ที่ client
    // ส่งมา (schema เดียวกับ Worker) จึงถูกละเว้นเสมอสำหรับ Admin ไม่ใช่บั๊ก
    const sessionDevice = {
      deviceId: getDefaultSessionDeviceId(account),
      deviceName: getDefaultSessionDeviceName(account),
    };

    return withTransaction(async (transaction) => {
      // ล็อกแถว Account ก่อนเช็ค Active Session เดิม กัน race ระหว่าง login พร้อมกันสองคำขอที่ต่างฝ่าย
      // ต่างเห็น session เดิมก่อนอีกฝ่าย commit แล้วจบด้วยการมี active session มากกว่า 1 session พร้อมกัน
      await transaction.$queryRaw`SELECT id FROM accounts WHERE id = ${account.id} FOR UPDATE`;

      const activeSession = await sessionRepository.findActiveByAccountId(
        account.id,
        transaction
      );

      if (activeSession) {
        await revoke(activeSession.id, transaction);
      }

      const tokens = await createAdminSession(
        account,
        sessionDevice.deviceId,
        sessionDevice.deviceName,
        transaction
      );

      await writeSecurityAuditLog(
        {
          event_type: SECURITY_AUDIT_EVENT_TYPE.AUTH_LOGIN_SUCCEEDED,
          outcome: SECURITY_AUDIT_OUTCOME.SUCCESS,
          actor_type: "admin",
          actor_account_id: account.id,
          actor_username: account.username,
          actor_full_name: account.full_name,
          session_id: tokens.session.id,
          ip_address: context.ip_address,
          user_agent: context.user_agent,
          request_id: context.request_id,
        },
        transaction
      );

      return buildAuthSuccessResponse(tokens);
    });
  }

  const matchedWorker = worker as MasterWorkerDto;

  if (matchedWorker.status !== MASTER_WORKER_STATUS.ACTIVE) {
    void writeSecurityAuditLogBestEffort({
      event_type: SECURITY_AUDIT_EVENT_TYPE.AUTH_LOGIN_FAILED,
      outcome: SECURITY_AUDIT_OUTCOME.FAILURE,
      actor_type: "worker",
      actor_worker_id: matchedWorker.id,
      actor_username: matchedWorker.labor_code,
      actor_full_name: matchedWorker.full_name,
      failure_code: "account_inactive",
      ip_address: context.ip_address,
      user_agent: context.user_agent,
      request_id: context.request_id,
    });

    throw new ApiError(423, "ACCOUNT_INACTIVE", "Account is inactive.");
  }

  const activeSession = await workerSessionRepository.findActiveByWorkerId(matchedWorker.id);
  const sessionDevice = requireWorkerDevice(deviceId, deviceName);

  assertNoConflictingWorkerSession(matchedWorker.id, activeSession, sessionDevice);

  return withTransaction(async (transaction) => {
    // ล็อกแถว MasterWorker แล้วอ่าน active session ใหม่ภายใต้ lock เดียวกัน กัน race ระหว่าง login พร้อมกัน
    // สองอุปกรณ์ — เช็คนอก transaction มีไว้ fail-fast เพื่อ UX เท่านั้น ต้อง re-check ใหม่เสมอหลังได้ lock แล้ว
    await transaction.$queryRaw`SELECT id FROM master_workers WHERE id = ${matchedWorker.id} FOR UPDATE`;

    const currentActiveSession = await workerSessionRepository.findActiveByWorkerId(
      matchedWorker.id,
      transaction
    );

    assertNoConflictingWorkerSession(matchedWorker.id, currentActiveSession, sessionDevice);

    if (currentActiveSession) {
      await workerSessionRepository.revoke(currentActiveSession.id, transaction);
      await revokeWorkerPushTokensBySession(currentActiveSession.id, transaction);
    }

    const tokens = await createWorkerSession(
      matchedWorker,
      sessionDevice.deviceId,
      sessionDevice.deviceName,
      transaction
    );
    await registerWorkerPushTokenForAccount(
      {
        worker_id: matchedWorker.id,
        worker_code: matchedWorker.labor_code,
        session_id: tokens.session.id,
        device_id: sessionDevice.deviceId,
        platform,
        fcm_token: fcmToken,
      },
      transaction
    );

    await writeSecurityAuditLog(
      {
        event_type: SECURITY_AUDIT_EVENT_TYPE.AUTH_LOGIN_SUCCEEDED,
        outcome: SECURITY_AUDIT_OUTCOME.SUCCESS,
        actor_type: "worker",
        actor_worker_id: matchedWorker.id,
        actor_username: matchedWorker.labor_code,
        actor_full_name: matchedWorker.full_name,
        session_id: tokens.session.id,
        ip_address: context.ip_address,
        user_agent: context.user_agent,
        request_id: context.request_id,
      },
      transaction
    );

    return buildAuthSuccessResponse(tokens);
  });
}

// Function ดึง default session device ID ของ Admin ใน service flow
function getDefaultSessionDeviceId(account: AccountDto): string {
  return `admin:${account.id}`;
}

// Function ดึง default session device name ของ Admin ใน service flow
function getDefaultSessionDeviceName(_account: AccountDto): string {
  return ADMIN_SESSION_DEVICE_NAME;
}

// Function ยืนยัน force login ใน service flow
export async function confirmForceLogin(
  body: unknown,
  context: SecurityAuditRequestContext
) {
  const {
    login_challenge_token: loginChallengeToken,
    device_id: deviceId,
    device_name: deviceName,
    fcm_token: fcmToken,
    platform,
  } = parseWithSchema(confirmForceLoginBodySchema, body);
  const challenge = verifyLoginChallengeToken(loginChallengeToken);

  if (challenge.new_device_id !== deviceId) {
    throw new ApiError(
      401,
      "INVALID_LOGIN_CHALLENGE",
      "Invalid login challenge."
    );
  }

  // Force login รองรับเฉพาะ Worker — signLoginChallengeToken สร้าง token นี้ด้วย role: WORKER_ROLE เสมอ
  // (Admin ไม่มี flow นี้) เหลือ guard นี้ไว้กันกรณี token ผิดปกติเท่านั้น
  if (challenge.role !== WORKER_ROLE) {
    throw new ApiError(
      401,
      "INVALID_LOGIN_CHALLENGE",
      "Invalid login challenge."
    );
  }

  const oldSession = await workerSessionRepository.findActiveById(challenge.old_session_id);

  if (!oldSession || oldSession.account_id !== challenge.account_id) {
    throw new ApiError(
      401,
      "INVALID_LOGIN_CHALLENGE",
      "Login challenge session is no longer active."
    );
  }

  const worker = await requireActiveWorkerById(
    challenge.account_id,
    423,
    "ACCOUNT_INACTIVE",
    "Account is inactive."
  );
  const notificationPayload = {
    reason: "force_login",
    old_device_id: oldSession.device_id,
    old_device_name: oldSession.device_name,
    new_device_id: deviceId,
    new_device_name: deviceName,
  };

  const response = await withTransaction(async (transaction) => {
    await workerSessionRepository.revoke(oldSession.id, transaction);
    await revokeWorkerPushTokensBySession(oldSession.id, transaction);

    const tokens = await createWorkerSession(worker, deviceId, deviceName, transaction);
    await registerWorkerPushTokenForAccount(
      {
        worker_id: worker.id,
        worker_code: worker.labor_code,
        session_id: tokens.session.id,
        device_id: deviceId,
        platform,
        fcm_token: fcmToken,
      },
      transaction
    );

    // auth_session_revoked แยกจาก auth_force_login — session_id คือ session เดิมที่ถูก revoke (ต่างจาก
    // auth_force_login ที่ session_id คือ session ใหม่) ใช้ request_id เดียวกันเพื่อ trace 2 event นี้กลับมาหากันได้
    await writeSecurityAuditLog(
      {
        event_type: SECURITY_AUDIT_EVENT_TYPE.AUTH_SESSION_REVOKED,
        outcome: SECURITY_AUDIT_OUTCOME.SUCCESS,
        actor_type: "worker",
        actor_worker_id: worker.id,
        actor_username: worker.labor_code,
        actor_full_name: worker.full_name,
        session_id: oldSession.id,
        ip_address: context.ip_address,
        user_agent: context.user_agent,
        request_id: context.request_id,
        metadata: { revoke_source: "force_login", new_session_id: tokens.session.id },
      },
      transaction
    );

    await writeSecurityAuditLog(
      {
        event_type: SECURITY_AUDIT_EVENT_TYPE.AUTH_FORCE_LOGIN,
        outcome: SECURITY_AUDIT_OUTCOME.SUCCESS,
        actor_type: "worker",
        actor_worker_id: worker.id,
        actor_username: worker.labor_code,
        actor_full_name: worker.full_name,
        session_id: tokens.session.id,
        ip_address: context.ip_address,
        user_agent: context.user_agent,
        request_id: context.request_id,
        metadata: { revoked_session_id: oldSession.id },
      },
      transaction
    );

    return buildAuthSuccessResponse(tokens);
  });

  // แจ้งเตือนอุปกรณ์เดิมหลัง commit สำเร็จจริงเท่านั้น เพื่อไม่ให้อุปกรณ์เดิมถูกหลอกว่า session ถูก revoke
  // ไปแล้วทั้งที่ transaction อาจ fail และ session เดิมยังใช้งานได้จริงอยู่ — เป็น best-effort ไม่ให้ error ตรงนี้ทำให้ response พัง
  sendWorkerSocketEvent(worker.id, "SESSION_REVOKED", notificationPayload, {
    push: false,
    notificationKey: "auth.session_revoked",
    notificationParams: notificationPayload,
    fallbackTitle: "Signed in on another device",
    fallbackMessage:
      "This session was signed out because login was confirmed on another device.",
  });
  await sendWorkerPushNotificationToSession({
    session_id: oldSession.id,
    type: "SESSION_REVOKED",
    title: "Signed in on another device",
    message:
      "This session was signed out because login was confirmed on another device.",
    notification_key: "auth.session_revoked",
    notification_params: notificationPayload,
    lang: worker.lang,
    payload: notificationPayload,
  }).catch((error) => {
    logger.warn("Failed to send force-login push notification to previous session.", { error });
  });

  return response;
}

// Function ต่ออายุ access token ด้วย refresh token ใน service flow
export async function refresh(body: unknown) {
  const { refresh_token: refreshToken } = parseWithSchema(refreshBodySchema, body);
  const payload = verifyRefreshToken(refreshToken);

  if (payload.role === WORKER_ROLE) {
    const session = await workerSessionRepository.findActiveById(payload.session_id);

    if (!session || session.account_id !== payload.account_id) {
      throw new ApiError(401, "INVALID_REFRESH_TOKEN", "Invalid refresh token.");
    }

    const candidateHash = hashRefreshToken(refreshToken);

    if (!refreshTokenHashesMatch(candidateHash, session.refresh_token_hash)) {
      throw new ApiError(401, "INVALID_REFRESH_TOKEN", "Invalid refresh token.");
    }

    const worker = await requireActiveWorkerById(
      payload.account_id,
      423,
      "ACCOUNT_INACTIVE",
      "Account is inactive."
    );

    const accessToken = signAccessToken({
      account_id: worker.id,
      role: WORKER_ROLE,
      permission_level: null,
      permissions: [],
      session_id: session.id,
    });
    const nextRefreshToken = signRefreshToken({
      account_id: worker.id,
      role: WORKER_ROLE,
      session_id: session.id,
    });
    const rotated = await workerSessionRepository.updateRefreshTokenHash(
      session.id,
      hashRefreshToken(nextRefreshToken),
      session.refresh_token_hash
    );

    if (!rotated) {
      throw new ApiError(401, "INVALID_REFRESH_TOKEN", "Invalid refresh token.");
    }

    return {
      access_token: accessToken,
      refresh_token: nextRefreshToken,
      token_type: "Bearer",
      expires_in: getAccessTokenExpiresInSeconds(),
    };
  }

  const session = await findActiveById(payload.session_id);

  if (!session || session.account_id !== payload.account_id) {
    throw new ApiError(
      401,
      "INVALID_REFRESH_TOKEN",
      "Invalid refresh token."
    );
  }

  const candidateHash = hashRefreshToken(refreshToken);

  if (!refreshTokenHashesMatch(candidateHash, session.refresh_token_hash)) {
    throw new ApiError(
      401,
      "INVALID_REFRESH_TOKEN",
      "Invalid refresh token."
    );
  }

  const account = await requireActiveAccountById(
    payload.account_id,
    423,
    "ACCOUNT_INACTIVE",
    "Account is inactive."
  );

  const accountPermissions = await getAccountPermissions(account);
  const accessToken = signAccessToken({
    account_id: account.id,
    role: account.role,
    permission_level: account.permission_level,
    permissions: accountPermissions.permissions,
    session_id: session.id,
  });
  const nextRefreshToken = signRefreshToken({
    account_id: account.id,
    role: account.role,
    session_id: session.id,
  });

  const rotated = await updateRefreshTokenHash(
    session.id,
    hashRefreshToken(nextRefreshToken),
    session.refresh_token_hash
  );

  if (!rotated) {
    // แพ้ race ให้อีก request ที่ใช้ refresh token เดิมตัวเดียวกันรีเฟรชไปก่อนแล้ว (เช่น 2 tab เจอ 401
    // พร้อมกันแล้ว trigger refresh ด้วย token เดิม) — token นี้ไม่ใช่ตัวล่าสุดของ session นี้อีกต่อไป
    throw new ApiError(
      401,
      "INVALID_REFRESH_TOKEN",
      "Invalid refresh token."
    );
  }

  return {
    access_token: accessToken,
    refresh_token: nextRefreshToken,
    token_type: "Bearer",
    expires_in: getAccessTokenExpiresInSeconds(),
  };
}

// Function จัดการ logout ใน service flow
export async function logout(
  auth: AccessTokenPayload | undefined,
  context: SecurityAuditRequestContext
) {
  if (!auth || !auth.session_id) {
    throw new ApiError(401, "INVALID_TOKEN", "Invalid or expired token.");
  }

  if (auth.role === WORKER_ROLE) {
    const worker = await masterWorkerRepository.findById(auth.account_id);
    const currentQueueEntry = await getWorkerQueueStatus(auth.account_id);

    if (
      worker &&
      currentQueueEntry &&
      currentQueueEntry.status !== WORKER_WORK_STATUS.OPEN_APP
    ) {
      try {
        await performWorkerOfflineCascade(worker, "worker_logout");
      } catch (error) {
        logger.error(
          "Failed to auto go-offline during worker logout.",
          { error, accountId: worker.id },
        );

        throw new ApiError(
          409,
          "WORKER_STILL_ONLINE",
          "Worker must go offline before logging out.",
        );
      }
    }

    await withTransaction(async (transaction) => {
      await workerSessionRepository.revoke(auth.session_id, transaction);
      await revokeWorkerPushTokensBySession(auth.session_id, transaction);

      await writeSecurityAuditLog(
        {
          event_type: SECURITY_AUDIT_EVENT_TYPE.AUTH_LOGOUT,
          outcome: SECURITY_AUDIT_OUTCOME.SUCCESS,
          actor_type: "worker",
          actor_worker_id: auth.account_id,
          actor_username: worker?.labor_code ?? null,
          actor_full_name: worker?.full_name ?? null,
          session_id: auth.session_id,
          ip_address: context.ip_address,
          user_agent: context.user_agent,
          request_id: context.request_id,
        },
        transaction
      );
    });

    try {
      await disconnectWorkerSocket(auth.account_id, "worker_logout");
    } catch (error) {
      logger.error(
        "Failed to disconnect worker socket after logout.",
        { error, accountId: auth.account_id },
      );
    }

    return {
      message: "Logged out successfully.",
    };
  }

  const account = await accountRepository.findById(auth.account_id);

  await withTransaction(async (transaction) => {
    await revoke(auth.session_id, transaction);

    await writeSecurityAuditLog(
      {
        event_type: SECURITY_AUDIT_EVENT_TYPE.AUTH_LOGOUT,
        outcome: SECURITY_AUDIT_OUTCOME.SUCCESS,
        actor_type: "admin",
        actor_account_id: auth.account_id,
        actor_username: account?.username ?? null,
        actor_full_name: account?.full_name ?? null,
        session_id: auth.session_id,
        ip_address: context.ip_address,
        user_agent: context.user_agent,
        request_id: context.request_id,
      },
      transaction
    );
  });

  return {
    message: "Logged out successfully.",
  };
}

// Function จัดการ register worker push token ใน service flow
export async function registerWorkerPushToken(
  auth: AccessTokenPayload | undefined,
  session: SessionDto | undefined,
  body: unknown
) {
  return registerWorkerPushTokenForSession(auth, session, body);
}

// Function จัดการ me ใน service flow
export async function me(
  auth?: AccessTokenPayload,
  currentSession?: SessionDto | null
): Promise<MeResponse> {
  if (!auth || !auth.account_id) {
    throw new ApiError(401, "INVALID_TOKEN", "Invalid or expired token.");
  }

  if (auth.role === WORKER_ROLE) {
    const worker = await requireActiveWorkerById(
      auth.account_id,
      401,
      "INVALID_TOKEN",
      "Invalid or expired token."
    );

    return buildWorkerMeResponse(worker);
  }

  const account = await requireActiveAccountById(
    auth.account_id,
    401,
    "INVALID_TOKEN",
    "Invalid or expired token."
  );

  return buildAdminMeResponse(account, currentSession);
}

// Function จัดการ change own password — Admin เท่านั้น (route gate ด้วย roleMiddleware(["admin"]))
// เพราะ Worker password มาจาก telephone เสมอ ไม่มี password อิสระให้เปลี่ยน
export async function changeOwnPassword(
  auth: AccessTokenPayload | undefined,
  body: unknown,
  context: SecurityAuditRequestContext
): Promise<{ message: string }> {
  if (!auth || !auth.account_id || !auth.session_id) {
    throw new ApiError(401, "INVALID_TOKEN", "Invalid or expired token.");
  }

  const { current_password: currentPassword, new_password: newPassword } =
    parseWithSchema(changeOwnPasswordBodySchema, body);
  const account = await requireActiveAccountById(
    auth.account_id,
    401,
    "INVALID_TOKEN",
    "Invalid or expired token."
  );

  if (!(await verifyPassword(currentPassword, account.password_hash))) {
    throw new ApiError(
      400,
      "INVALID_CURRENT_PASSWORD",
      "Current password is incorrect."
    );
  }

  return withTransaction(async (transaction) => {
    await accountRepository.updatePassword(
      account.id,
      await hashPassword(newPassword),
      transaction
    );
    const revokedSessionCount = await sessionRepository.revokeActiveByAccountIdExcept(
      account.id,
      auth.session_id,
      transaction
    );

    await writeSecurityAuditLog(
      {
        event_type: SECURITY_AUDIT_EVENT_TYPE.ACCOUNT_PASSWORD_CHANGED,
        outcome: SECURITY_AUDIT_OUTCOME.SUCCESS,
        actor_type: "admin",
        actor_account_id: account.id,
        actor_username: account.username,
        actor_full_name: account.full_name,
        session_id: auth.session_id,
        ip_address: context.ip_address,
        user_agent: context.user_agent,
        request_id: context.request_id,
        metadata: { revokedSessionCount },
      },
      transaction
    );

    return {
      message: "Password changed successfully.",
    };
  });
}

// Function จัดการ update own lang (UI language) ใน service flow — ใช้ได้ทั้ง Admin และ Worker
export async function updateOwnLang(
  auth: AccessTokenPayload | undefined,
  body: unknown
): Promise<UpdateLangResponse> {
  if (!auth || !auth.account_id) {
    throw new ApiError(401, "INVALID_TOKEN", "Invalid or expired token.");
  }

  const { lang } = parseWithSchema(updateOwnLangBodySchema, body);

  if (auth.role === WORKER_ROLE) {
    await requireActiveWorkerById(auth.account_id, 401, "INVALID_TOKEN", "Invalid or expired token.");
    const updatedWorker = await masterWorkerRepository.updateLang(auth.account_id, lang);

    return {
      message: "Language updated successfully.",
      lang: updatedWorker.lang,
    };
  }

  const account = await requireActiveAccountById(
    auth.account_id,
    401,
    "INVALID_TOKEN",
    "Invalid or expired token."
  );

  const updatedAccount = await accountRepository.updateLang(account.id, lang);

  return {
    message: "Language updated successfully.",
    lang: updatedAccount.lang,
  };
}

// Function จัดการ update own profile (full_name/email/phone) — Admin เท่านั้น (route gate ด้วย
// roleMiddleware(["admin"])) ใช้ buildAdminMeResponse เดิมเพื่อคืน profile รูปแบบเดียวกันทุกที่
export async function updateOwnProfile(
  auth: AccessTokenPayload | undefined,
  currentSession: SessionDto | undefined,
  body: unknown,
  context: SecurityAuditRequestContext
): Promise<MeResponse> {
  if (!auth || !auth.account_id) {
    throw new ApiError(401, "INVALID_TOKEN", "Invalid or expired token.");
  }

  const input = parseWithSchema(updateOwnProfileBodySchema, body);
  const account = await requireActiveAccountById(
    auth.account_id,
    401,
    "INVALID_TOKEN",
    "Invalid or expired token."
  );
  // Snapshot ก่อนแก้ไขจริง กัน repository (โดยเฉพาะ mock ของ test) คืน object เดิมแทน fresh copy
  const accountBeforeUpdate = { ...account };

  return withTransaction(async (transaction) => {
    const updatedAccount = await accountRepository.updateProfile(
      account.id,
      {
        full_name: input.full_name,
        email: input.email,
        phone: input.phone,
      },
      transaction
    );
    const diff = diffChangedFields(accountBeforeUpdate, updatedAccount, [
      "full_name",
      "email",
      "phone",
    ]);

    if (diff) {
      await writeSecurityAuditLog(
        {
          event_type: SECURITY_AUDIT_EVENT_TYPE.ADMIN_PROFILE_UPDATED,
          outcome: SECURITY_AUDIT_OUTCOME.SUCCESS,
          actor_type: "admin",
          actor_account_id: account.id,
          actor_username: account.username,
          actor_full_name: updatedAccount.full_name,
          session_id: auth.session_id,
          ip_address: context.ip_address,
          user_agent: context.user_agent,
          request_id: context.request_id,
          metadata: {
            targetType: "admin_account",
            targetAccountId: account.id,
            before: diff.before,
            after: diff.after,
          },
        },
        transaction
      );
    }

    return buildAdminMeResponse(updatedAccount, currentSession);
  });
}

// Function จัดการ upload own profile image — Admin เท่านั้น รูปของ Worker มาจาก MasterWorker.picture (sync จาก Master) เท่านั้น
export async function uploadOwnProfileImage(
  auth: AccessTokenPayload | undefined,
  imageUrl: string,
  context: SecurityAuditRequestContext
): Promise<{ message: string; image_url: string }> {
  if (!auth || !auth.account_id) {
    throw new ApiError(401, "INVALID_TOKEN", "Invalid or expired token.");
  }

  const account = await requireActiveAccountById(
    auth.account_id,
    401,
    "INVALID_TOKEN",
    "Invalid or expired token."
  );
  const previousImageUrl = account.image_url;

  const result = await withTransaction(async (transaction) => {
    const updatedAccount = await accountRepository.updateProfile(
      account.id,
      { image_url: imageUrl },
      transaction
    );

    await writeSecurityAuditLog(
      {
        event_type: SECURITY_AUDIT_EVENT_TYPE.ADMIN_PROFILE_UPDATED,
        outcome: SECURITY_AUDIT_OUTCOME.SUCCESS,
        actor_type: "admin",
        actor_account_id: account.id,
        actor_username: account.username,
        actor_full_name: account.full_name,
        session_id: auth.session_id,
        ip_address: context.ip_address,
        user_agent: context.user_agent,
        request_id: context.request_id,
        metadata: {
          targetType: "admin_account",
          targetAccountId: account.id,
          changed: ["image_url"],
        },
      },
      transaction
    );

    return {
      message: "Profile image uploaded successfully.",
      image_url: updatedAccount.image_url ?? imageUrl,
    };
  });

  // ลบรูปเก่าออกจาก DigitalOcean Spaces แบบ best-effort หลัง commit สำเร็จแล้วเท่านั้น (ลบไม่สำเร็จไม่ทำให้ request หลักล้มเหลว)
  if (previousImageUrl && previousImageUrl !== imageUrl) {
    await deleteAdminProfileImageByUrl(previousImageUrl).catch((error) => {
      logger.error("Failed to delete previous admin profile image from storage.", { error });
    });
  }

  return result;
}
