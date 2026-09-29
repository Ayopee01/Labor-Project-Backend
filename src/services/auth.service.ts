// Import Config
import { getAccessTokenExpiresInSeconds, getAdminRefreshExpiresInSeconds, getWorkerRefreshExpiresInSeconds } from "../config/auth.config";
import { EMPTY_SECURITY_AUDIT_CONTEXT } from "../config/security-audit.config";
import { deleteAdminProfileImageByUrl } from "../config/spaces";
import { withTransaction } from "../db/prisma";
// Import Repositories
import { createPending, findActiveById, findByUsername, revoke, updateRefreshTokenHash } from "../repositories/auth.repository";
import * as accountRepository from "../repositories/shared/account.repository";
import * as sessionRepository from "../repositories/shared/session.repository";
import * as masterWorkerRepository from "../repositories/shared/master-worker.repository";
import * as workerSessionRepository from "../repositories/shared/worker-session.repository";
// Import Services
import { getAccountPermissions } from "./shared/account-permission.service";
import { performWorkerOfflineCascade } from "./worker.service";
import { registerWorkerPushToken as registerWorkerPushTokenForSession, registerWorkerPushTokenForAccount, revokeWorkerPushTokensBySession, sendWorkerPushNotificationToSession } from "./shared/worker-push.service";
import { sendAdminSseEventToSession } from "./notifications.service";
import { diffChangedFields, writeSecurityAuditLog, writeSecurityAuditLogBestEffort } from "./shared/security-audit-log.service";
// Import Queues
import { getWorkerQueueStatus } from "../queues/worker-queue";
// Import Websockets
import { disconnectWorkerSocket, sendWorkerSocketEvent } from "../websockets/worker.socket";
// Import Types
import { SECURITY_AUDIT_EVENT_TYPE, SECURITY_AUDIT_OUTCOME } from "../types/shared/security-audit-log.type";
import type { AccessTokenPayload, AuthSuccessResponse, AuthTokens, MeResponse, ProfileCardShift, SessionDto, UpdateLangResponse } from "../types/auth.type";
import type { DbConnection } from "../types/shared/common.type";
import { MASTER_WORKER_STATUS } from "../types/admin-workers.type";
import type { AccountDto, MasterWorkerDto, WorkScheduleDto } from "../types/admin-workers.type";
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

/* -------------------------------------- Config -------------------------------------- */

// Config role ของ worker และชื่ออุปกรณ์ของ session Admin
const WORKER_ROLE = "worker";

const ADMIN_SESSION_DEVICE_NAME = "Admin Web";

// Config hash หลอกให้ verify password ทำงานเสมอแม้ไม่พบ user (กัน timing attack)
const dummyPasswordHashPromise = hashPassword(
  "dummy-password-for-constant-time-login-check"
);

/* -------------------------------------- Admin Helpers -------------------------------------- */

// Function ดึง account ที่ยัง active ตาม ID (ไม่ active throw ตาม error ที่ส่งมา)
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

// Function สร้างรหัสพนักงานของ Admin จาก account id
function buildAdminEmployeeCode(accountId: number): string {
  return `ADM${String(accountId).padStart(4, "0")}`;
}

// Function จัดรูปแบบข้อมูลกะสำหรับ profile card
function formatProfileCardShift(
  schedule: WorkScheduleDto | null
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

// Function สร้าง response ข้อมูลตัวเองของ Admin
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
    // ไม่มีรูปต้องส่ง null เสมอ (ห้ามละ field)
    image_url: account.image_url ?? null,
    permission_level: account.permission_level,
    permissions: accountPermissions.permissions,
    lang: account.lang,
    latest_active_at: latestActiveAt,
  };
}

// Function สร้าง response ข้อมูลตัวเองของ Worker
function buildWorkerMeResponse(worker: MasterWorkerDto): MeResponse {
  const schedule: WorkScheduleDto | null =
    worker.shift_name !== null && worker.time_in !== null && worker.time_out !== null
      ? {
          id: worker.id,
          worker_id: worker.id,
          shift_name: worker.shift_name,
          work_date: worker.work_start_date ?? worker.created_at.slice(0, 10),
          time_in: worker.time_in,
          time_out: worker.time_out,
          is_current: true,
          created_by: null,
          updated_by: null,
          created_at: worker.created_at,
          updated_at: worker.updated_at,
        }
      : null;

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

// Function ตรวจว่า worker ส่งข้อมูลอุปกรณ์มาครบ
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

// Function ตรวจ session เดิมของ worker ถ้าคนละเครื่อง throw 409 พร้อม challenge token
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

// Function สร้าง session และ token ของ Admin
async function createAdminSession(
  account: AccountDto,
  deviceId: string,
  deviceName: string,
  connection: DbConnection
): Promise<AuthTokens> {
  const adminRefreshExpiresInSeconds = getAdminRefreshExpiresInSeconds();
  const expiresAt = new Date(
    Date.now() + adminRefreshExpiresInSeconds * 1000
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
  const refreshToken = signRefreshToken(
    {
      account_id: account.id,
      role: account.role,
      session_id: session.id,
    },
    { expiresIn: adminRefreshExpiresInSeconds }
  );

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

// Function สร้าง session และ token ของ Worker
async function createWorkerSession(
  worker: MasterWorkerDto,
  deviceId: string,
  deviceName: string,
  connection: DbConnection
): Promise<AuthTokens> {
  const workerRefreshExpiresInSeconds = getWorkerRefreshExpiresInSeconds();
  const expiresAt = new Date(
    Date.now() + workerRefreshExpiresInSeconds * 1000
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
  const refreshToken = signRefreshToken(
    {
      account_id: worker.id,
      role: WORKER_ROLE,
      session_id: session.id,
    },
    { expiresIn: workerRefreshExpiresInSeconds }
  );

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

// Function สร้าง response หลัง login สำเร็จ
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

// Function login ของ Admin (username) หรือ Worker (LaborCode) โดย verify password เสมอเพื่อกัน timing attack
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
  // ค้นหาทั้ง Admin และ Worker พร้อมกันเสมอ เพื่อให้เวลาตอบสนองเท่ากัน
  const [account, workerLookup] = await Promise.all([
    findByUsername(username),
    masterWorkerRepository.findByLaborCode(username),
  ]);
  const worker = account ? null : workerLookup;
  const passwordHash =
    account?.password_hash ?? worker?.password_hash ?? (await dummyPasswordHashPromise);
  const passwordValid = await verifyPassword(password, passwordHash);

  if ((!account && !worker) || !passwordValid) {
    // ไม่ await เพื่อไม่ให้เวลาตอบ 401 ขึ้นกับการเขียน log
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

    // Admin มี session เดียวเสมอ จึงไม่ใช้ device ที่ client ส่งมา
    const sessionDevice = {
      deviceId: getDefaultSessionDeviceId(account),
      deviceName: getDefaultSessionDeviceName(account),
    };

    const { authResponse, revokedSessionId } = await withTransaction(async (transaction) => {
      // lock account ก่อนเช็ค session เดิม กัน login พร้อมกันแล้วมีหลาย session
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

      return {
        authResponse: buildAuthSuccessResponse(tokens),
        revokedSessionId: activeSession?.id ?? null,
      };
    });

    // แจ้ง session เดิมหลัง commit แบบ best-effort (ส่งไม่สำเร็จไม่ทำให้ login ล้ม)
    if (revokedSessionId) {
      try {
        sendAdminSseEventToSession(revokedSessionId, "SESSION_REVOKED", {
          reason: "LOGIN_FROM_ANOTHER_DEVICE",
          message: "บัญชีนี้มีการเข้าสู่ระบบจากเครื่องอื่น",
        });
      } catch (error) {
        logger.warn("Failed to notify previous admin session after login.", {
          error,
          accountId: account.id,
          sessionId: revokedSessionId,
        });
      }
    }

    return authResponse;
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
    // lock worker แล้วเช็ค session เดิมซ้ำ กัน login พร้อมกันสองเครื่อง
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

// Function สร้าง device id ของ session Admin
function getDefaultSessionDeviceId(account: AccountDto): string {
  return `admin:${account.id}`;
}

// Function คืนชื่ออุปกรณ์ของ session Admin
function getDefaultSessionDeviceName(_account: AccountDto): string {
  return ADMIN_SESSION_DEVICE_NAME;
}

// Function ยืนยัน login แทน session เดิมของ Worker ด้วย challenge token
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

  // force login รองรับเฉพาะ Worker
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
    // lock worker แล้วเช็ค session เดิมซ้ำ กันกดยืนยันซ้ำจนมีสอง session
    await transaction.$queryRaw`SELECT id FROM master_workers WHERE id = ${worker.id} FOR UPDATE`;

    const lockedOldSession = await workerSessionRepository.findActiveById(
      oldSession.id,
      transaction
    );

    if (!lockedOldSession || lockedOldSession.account_id !== challenge.account_id) {
      throw new ApiError(
        401,
        "INVALID_LOGIN_CHALLENGE",
        "Login challenge session is no longer active."
      );
    }

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

    // บันทึก session เดิมที่ถูก revoke แยก event (request_id เดียวกันใช้ trace คู่กัน)
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

  // แจ้งอุปกรณ์เดิมหลัง commit แบบ best-effort
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

// Function ออก token ชุดใหม่ด้วย refresh token
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
    const nextRefreshToken = signRefreshToken(
      {
        account_id: worker.id,
        role: WORKER_ROLE,
        session_id: session.id,
      },
      { expiresIn: getWorkerRefreshExpiresInSeconds() }
    );
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
  const nextRefreshToken = signRefreshToken(
    {
      account_id: account.id,
      role: account.role,
      session_id: session.id,
    },
    { expiresIn: getAdminRefreshExpiresInSeconds() }
  );

  const rotated = await updateRefreshTokenHash(
    session.id,
    hashRefreshToken(nextRefreshToken),
    session.refresh_token_hash
  );

  if (!rotated) {
    // อีก request ใช้ refresh token เดียวกัน refresh ไปก่อนแล้ว
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

// Function logout และ revoke session ปัจจุบัน
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

// Function บันทึก FCM push token ของ worker
export async function registerWorkerPushToken(
  auth: AccessTokenPayload | undefined,
  session: SessionDto | undefined,
  body: unknown
) {
  return registerWorkerPushTokenForSession(auth, session, body);
}

// Function ดึงข้อมูลตัวเองของผู้ที่ login อยู่
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

// Function เปลี่ยน password ของตัวเอง (Admin เท่านั้น)
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

// Function เปลี่ยนภาษาของตัวเอง (ทั้ง Admin และ Worker)
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

// Function แก้ไข profile ของตัวเอง (Admin เท่านั้น)
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

// Function อัปโหลดรูป profile ของตัวเอง (Admin เท่านั้น)
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

  // ลบรูปเก่าใน Spaces หลัง commit แบบ best-effort
  if (previousImageUrl && previousImageUrl !== imageUrl) {
    await deleteAdminProfileImageByUrl(previousImageUrl).catch((error) => {
      logger.error("Failed to delete previous admin profile image from storage.", { error });
    });
  }

  return result;
}
