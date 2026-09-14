// Import Library
import { randomBytes } from "crypto";
// Import Config
import { ADMIN_PERMISSION_DEPENDENCIES, ADMIN_PERMISSION_LEVELS, OWNER_ONLY_PERMISSIONS, canManagePermissionLevel } from "../config/permission.config";
import type { AdminPermission } from "../config/permission.config";
import { EMPTY_SECURITY_AUDIT_CONTEXT } from "../config/security-audit.config";
import { withTransaction } from "../db/prisma";
// Import Repositories
import * as adminSettingsRepository from "../repositories/admin-settings.repository";
import * as accountRepository from "../repositories/shared/account.repository";
import * as gateClientRepository from "../repositories/shared/gate-client.repository";
import * as permissionRepository from "../repositories/shared/permission.repository";
import * as sessionRepository from "../repositories/shared/session.repository";
import { listSettings, upsertSettings } from "../repositories/shared/system-setting.repository";
// Import Queues
import { publishRuntimeSettingsInvalidation } from "../queues/runtime-settings-sync";
// Import Services
import { getAccountPermissions } from "./shared/account-permission.service";
import { clearRuntimeSettingsCache, getRuntimeSettings } from "./shared/runtime-settings.service";
import { diffChangedFields, writeSecurityAuditLog } from "./shared/security-audit-log.service";
import * as mobileAppVersionService from "./shared/mobile-app-version.service";
// Import Types
import { SECURITY_AUDIT_EVENT_TYPE, SECURITY_AUDIT_OUTCOME } from "../types/shared/security-audit-log.type";
import type { AccessTokenPayload } from "../types/auth.type";
import type { AccountDto } from "../types/admin-workers.type";
import type { DbConnection } from "../types/shared/common.type";
import type { AccountPermissionsResponse } from "../types/shared/account-permission.type";
import type { AdminRoleListResponse, RuntimeSettingsResponse } from "../types/admin-settings.type";
import type { GateClientDto, PublicGateClient } from "../types/shared/gate-client.type";
import type { GateClientListResponse, GateClientMutationResponse, GateClientSecretResponse } from "../types/admin-settings.type";
import type { SecurityAuditRequestContext } from "../types/shared/security-audit-log.type";
// Import Validation
import { parseId, parseWithSchema } from "../validation/parser";
import { createAdminAccountBodySchema, createGateClientBodySchema, resetPasswordBodySchema, updateAccountPermissionsBodySchema, updateAdminAccountBodySchema, updateGateClientBodySchema, updateSystemSettingsBodySchema } from "../validation/schemas";
// Import Utils
import { getActorId } from "../utils/actor";
import ApiError from "../utils/api-error";
import { hashPassword } from "../utils/password";

// Function ประกอบ actor snapshot (username/full_name) จาก actorId สำหรับ Security Audit Log — คืน null ทั้งคู่ถ้าไม่มี actorId
async function findActorSnapshot(
  actorId: number | null,
  connection?: DbConnection
): Promise<{ username: string | null; full_name: string | null }> {
  if (!actorId) {
    return { username: null, full_name: null };
  }

  const actor = await adminSettingsRepository.findAdminById(actorId, connection);

  return {
    username: actor?.username ?? null,
    full_name: actor?.full_name ?? null,
  };
}

/* -------------------------------------- Config -------------------------------------- */

const GATE_SECRET_PREFIX = "gate_live_";
const GENERATED_CLIENT_ID_PREFIX = "gate_";
const GENERATED_CLIENT_ID_BYTES = 8;
const GENERATED_SECRET_BYTES = 32;

/* -------------------------------------- Functions -------------------------------------- */

// Function จัดการ generate Gate client ID ใน service flow
function generateGateClientId(): string {
  return `${GENERATED_CLIENT_ID_PREFIX}${randomBytes(GENERATED_CLIENT_ID_BYTES).toString("hex")}`;
}

// Function จัดการ generate Gate client secret ใน service flow
function generateGateClientSecret(): string {
  return `${GATE_SECRET_PREFIX}${randomBytes(GENERATED_SECRET_BYTES).toString("base64url")}`;
}

// Function อ่านค่า client ID ใน service flow
function parseClientId(value: unknown): string {
  const clientId = String(value ?? "").trim();

  if (!clientId) {
    throw new ApiError(400, "INVALID_GATE_CLIENT_ID", "Gate client id is required.");
  }

  return clientId;
}

// Function จัดการ เป็น public Gate client ใน service flow
function toPublicGateClient(client: GateClientDto): PublicGateClient {
  const { secret_hash: _secretHash, ...publicClient } = client;

  return publicClient;
}

// Function จัดการ generate unique client ID ใน service flow
async function generateUniqueClientId(): Promise<string> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const clientId = generateGateClientId();

    if (!(await gateClientRepository.clientIdExists(clientId))) {
      return clientId;
    }
  }

  throw new ApiError(
    500,
    "GATE_CLIENT_ID_GENERATION_FAILED",
    "Unable to generate a unique Gate client id."
  );
}

// Function ตรวจสอบและดึง Gate client ใน service flow
async function requireGateClient(clientIdParam: unknown): Promise<GateClientDto> {
  const clientId = parseClientId(clientIdParam);
  const client = await gateClientRepository.findByClientId(clientId);

  if (!client) {
    throw new ApiError(404, "GATE_CLIENT_NOT_FOUND", "Gate client not found.");
  }

  return client;
}

// Function ดึง admin actor ที่ auth ผ่านแล้ว (401 ไม่มี auth / 403 ไม่ใช่ admin) — จุดร่วมที่ assertCan* ทุกตัวเรียกก่อนเช็คเงื่อนไขเฉพาะของตัวเอง
async function requireAdminActor(auth?: AccessTokenPayload): Promise<AccountDto> {
  const actorId = getActorId(auth);

  if (!actorId) {
    throw new ApiError(401, "UNAUTHORIZED", "Authentication is required.");
  }

  const actorAccount = await adminSettingsRepository.findAdminById(actorId);

  if (!actorAccount) {
    throw new ApiError(403, "ADMIN_ACTOR_NOT_FOUND", "Admin actor not found.");
  }

  return actorAccount;
}

// Function ตรวจสอบว่า actor จัดการ permissions ของ target ได้หรือไม่ — คืน actorAccount กลับไปให้ caller ใช้ต่อโดยไม่ต้อง query ซ้ำ
async function assertCanManageAdminPermissions(
  targetAccount: AccountDto,
  nextPermissionLevel: string,
  auth?: AccessTokenPayload
): Promise<AccountDto> {
  const actorAccount = await requireAdminActor(auth);

  if (actorAccount.id === targetAccount.id) {
    throw new ApiError(
      403,
      "CANNOT_UPDATE_OWN_PERMISSIONS",
      "Admin cannot update their own permissions."
    );
  }

  if (!canManagePermissionLevel(actorAccount.permission_level, targetAccount.permission_level)) {
    throw new ApiError(
      403,
      "TARGET_PERMISSION_LEVEL_NOT_MANAGEABLE",
      "Admin cannot update permissions for an equal or higher permission level."
    );
  }

  if (!canManagePermissionLevel(actorAccount.permission_level, nextPermissionLevel)) {
    throw new ApiError(
      403,
      "NEW_PERMISSION_LEVEL_NOT_MANAGEABLE",
      "Admin cannot assign an equal or higher permission level."
    );
  }

  return actorAccount;
}

// Function ตรวจสอบว่า actor จัดการ admin account อื่นได้หรือไม่ (แก้ข้อมูลพื้นฐาน/reset password)
// ใช้ hierarchy check เดียวกับ assertCanManageAdminPermissions แต่ไม่มี "next permission level" check เพราะ endpoint นี้ไม่ได้แก้ permission_level
async function assertCanManageAdminAccount(
  targetAccount: AccountDto,
  auth?: AccessTokenPayload
): Promise<void> {
  const actorAccount = await requireAdminActor(auth);

  if (actorAccount.id === targetAccount.id) {
    throw new ApiError(
      403,
      "CANNOT_MANAGE_OWN_ACCOUNT",
      "Admin cannot manage their own account through this endpoint. Use PATCH /api/auth/me instead."
    );
  }

  if (!canManagePermissionLevel(actorAccount.permission_level, targetAccount.permission_level)) {
    throw new ApiError(
      403,
      "TARGET_PERMISSION_LEVEL_NOT_MANAGEABLE",
      "Admin cannot manage an account with an equal or higher permission level."
    );
  }
}

// Function ตรวจสอบว่า permissions ที่จะมอบให้บัญชีอื่นเป็นสิทธิ์ที่ actor เองมีอยู่จริง ป้องกัน Privilege Escalation
// permission_level กำหนดแค่ "จัดการใครได้" ไม่ได้กำหนดว่าแจกสิทธิ์ใดได้บ้าง
async function assertPermissionsGrantable(
  actorAccount: AccountDto,
  requestedPermissions: AdminPermission[],
  connection?: DbConnection
): Promise<void> {
  const actorPermissions = new Set(
    await permissionRepository.listByAccountId(actorAccount.id, connection)
  );
  const ungrantable = requestedPermissions.filter(
    (permission) => !actorPermissions.has(permission)
  );

  if (ungrantable.length > 0) {
    throw new ApiError(
      403,
      "PERMISSIONS_NOT_GRANTABLE",
      `Admin cannot grant permissions they do not have: ${ungrantable.join(", ")}`
    );
  }
}

// Function ตรวจสอบว่า permission set ที่จะบันทึกเคารพ dependency ใน ADMIN_PERMISSION_DEPENDENCIES
// เช่น mobile_app_versions:create ต้องมาพร้อม mobile_app_versions:read เสมอ — ตรวจจาก requested set เอง ไม่ query DB เพิ่ม
function assertPermissionDependenciesSatisfied(
  requestedPermissions: AdminPermission[]
): void {
  const requested = new Set(requestedPermissions);
  const missing = new Set<AdminPermission>();

  for (const permission of requestedPermissions) {
    const dependencies = ADMIN_PERMISSION_DEPENDENCIES[permission] ?? [];

    for (const dependency of dependencies) {
      if (!requested.has(dependency)) {
        missing.add(dependency);
      }
    }
  }

  if (missing.size > 0) {
    throw new ApiError(
      400,
      "PERMISSION_DEPENDENCY_NOT_SATISFIED",
      `Missing required permissions: ${[...missing].join(", ")}`
    );
  }
}

// Function ดึงเฉพาะ permission ในกลุ่ม OWNER_ONLY_PERMISSIONS ออกมาเป็น Set ใน service flow
function ownerOnlyPermissionSubset(
  permissions: readonly AdminPermission[]
): Set<AdminPermission> {
  return new Set(
    permissions.filter((permission) =>
      (OWNER_ONLY_PERMISSIONS as readonly AdminPermission[]).includes(permission)
    )
  );
}

// Function ตรวจสอบว่า permission กลุ่ม OWNER_ONLY_PERMISSIONS ไม่ถูก grant/revoke โดย actor ที่ไม่ใช่ owner
// เข้มงวดเฉพาะตอนชุดนี้เปลี่ยนแปลงจริง (resubmit ค่าเดิมต้องผ่านได้ปกติ เพราะ endpoint เป็น full replace)
function assertOwnerOnlyPermissionsUnchanged(
  actorAccount: AccountDto,
  currentPermissions: readonly AdminPermission[],
  requestedPermissions: readonly AdminPermission[]
): void {
  if (actorAccount.permission_level === "owner") {
    return;
  }

  const current = ownerOnlyPermissionSubset(currentPermissions);
  const requested = ownerOnlyPermissionSubset(requestedPermissions);
  const isUnchanged =
    current.size === requested.size &&
    [...current].every((permission) => requested.has(permission));

  if (!isUnchanged) {
    throw new ApiError(
      403,
      "OWNER_ONLY_PERMISSIONS",
      `Only an owner-level admin can grant or revoke: ${OWNER_ONLY_PERMISSIONS.join(", ")}`
    );
  }
}

// Function ตรวจสอบว่า actor สร้าง admin ระดับที่ขอได้หรือไม่ — คืน actorAccount กลับไปให้ caller ใช้ต่อโดยไม่ต้อง query ซ้ำ
async function assertCanCreateAdminLevel(
  nextPermissionLevel: string,
  auth?: AccessTokenPayload
): Promise<AccountDto> {
  const actorAccount = await requireAdminActor(auth);

  if (!canManagePermissionLevel(actorAccount.permission_level, nextPermissionLevel)) {
    throw new ApiError(
      403,
      "NEW_PERMISSION_LEVEL_NOT_MANAGEABLE",
      "Admin cannot create an equal or higher permission level."
    );
  }

  return actorAccount;
}

// Function โหลดแอดมินเป้าหมายจาก DB ตาม id หรือ 404 — จุดร่วมที่ endpoint แก้ไข/อ่านแอดมินอื่นเรียกก่อนเช็คสิทธิ์เฉพาะของตัวเอง
async function requireAdminAccount(accountIdParam: unknown): Promise<AccountDto> {
  const accountId = parseId(accountIdParam);
  const account = await adminSettingsRepository.findAdminById(accountId);

  if (!account) {
    throw new ApiError(404, "ADMIN_NOT_FOUND", "Admin account not found.");
  }

  return account;
}

// Function ตรวจสอบเงื่อนไข admin username available ใน service flow
async function assertAdminUsernameAvailable(username: string): Promise<void> {
  const exists = await adminSettingsRepository.usernameExists(username);

  if (exists) {
    throw new ApiError(
      409,
      "USERNAME_ALREADY_EXISTS",
      "Username already exists."
    );
  }
}

// Function ตรวจสอบเงื่อนไข can read admin permissions ใน service flow
async function assertCanReadAdminPermissions(
  targetAccount: AccountDto,
  auth?: AccessTokenPayload
): Promise<void> {
  const actorAccount = await requireAdminActor(auth);

  if (actorAccount.id === targetAccount.id) {
    throw new ApiError(
      403,
      "CANNOT_READ_OWN_PERMISSIONS",
      "Admin cannot read their own permissions through this endpoint. Use /api/auth/me."
    );
  }

  if (!canManagePermissionLevel(actorAccount.permission_level, targetAccount.permission_level)) {
    throw new ApiError(
      403,
      "TARGET_PERMISSION_LEVEL_NOT_READABLE",
      "Admin cannot read permissions for an equal or higher permission level."
    );
  }
}

// Function ดึงรายการ system settings ใน service flow
export async function listSystemSettings(): Promise<RuntimeSettingsResponse> {
  return getRuntimeSettings();
}

// Function อัปเดต system settings ใน service flow
export async function updateSystemSettings(
  body: unknown,
  auth?: AccessTokenPayload,
  context: SecurityAuditRequestContext = EMPTY_SECURITY_AUDIT_CONTEXT
): Promise<RuntimeSettingsResponse> {
  const input = parseWithSchema(updateSystemSettingsBodySchema, body);
  const settingsToSave = Object.fromEntries(
    Object.entries(input).map(([key, value]) => [key, String(value)])
  );
  const actorId = getActorId(auth);

  await withTransaction(async (transaction) => {
    // อ่าน "ก่อน" ให้ครบก่อน upsert เพราะ SystemSetting ไม่มีประวัติ ค่าเดิมหายทันทีที่เขียนทับ
    const before = await listSettings(transaction);
    const beforeByKey = new Map(before.map((setting) => [setting.key, setting.value]));

    await upsertSettings(settingsToSave, actorId, transaction);

    const changedBefore: Record<string, unknown> = {};
    const changedAfter: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(settingsToSave)) {
      const previousValue = beforeByKey.get(key) ?? null;

      if (previousValue !== value) {
        changedBefore[key] = previousValue;
        changedAfter[key] = value;
      }
    }

    if (Object.keys(changedAfter).length > 0) {
      const actorSnapshot = await findActorSnapshot(actorId, transaction);

      await writeSecurityAuditLog(
        {
          event_type: SECURITY_AUDIT_EVENT_TYPE.SYSTEM_SETTINGS_UPDATED,
          outcome: SECURITY_AUDIT_OUTCOME.SUCCESS,
          actor_type: "admin",
          actor_account_id: actorId,
          actor_username: actorSnapshot.username,
          actor_full_name: actorSnapshot.full_name,
          ip_address: context.ip_address,
          user_agent: context.user_agent,
          request_id: context.request_id,
          metadata: {
            targetType: "system_settings",
            before: changedBefore,
            after: changedAfter,
          },
        },
        transaction
      );
    }
  });

  clearRuntimeSettingsCache();
  // แจ้ง instance อื่นให้ล้าง cache ของตัวเอง — ตอนนี้รันเดี่ยวจึงยังไม่มีผล แต่พร้อมรองรับตอน scale หลาย instance
  await publishRuntimeSettingsInvalidation();

  return getRuntimeSettings();
}

// Function ดึง Current/Scheduled/History ของ Mobile App Version ใน service flow
export async function listMobileAppVersions() {
  return mobileAppVersionService.getAdminMobileAppVersionOverview();
}

// Function สร้าง Mobile App Version ใหม่ใน service flow
export async function createMobileAppVersion(
  body: unknown,
  auth?: AccessTokenPayload,
  context: SecurityAuditRequestContext = EMPTY_SECURITY_AUDIT_CONTEXT
) {
  const actorId = getActorId(auth);
  const actorSnapshot = await findActorSnapshot(actorId);

  return mobileAppVersionService.createMobileAppVersion(
    body,
    actorId,
    { actor_account_id: actorId, ...actorSnapshot },
    context
  );
}

// Function แก้ไข Mobile App Version ใน service flow
export async function updateMobileAppVersion(
  idParam: unknown,
  body: unknown,
  auth?: AccessTokenPayload,
  context: SecurityAuditRequestContext = EMPTY_SECURITY_AUDIT_CONTEXT
) {
  const actorId = getActorId(auth);
  const actorSnapshot = await findActorSnapshot(actorId);

  return mobileAppVersionService.updateMobileAppVersion(
    idParam,
    body,
    actorId,
    { actor_account_id: actorId, ...actorSnapshot },
    context
  );
}

// Function ดึงรายการ Gate clients ใน service flow
export async function listGateClients(): Promise<GateClientListResponse> {
  const clients = await gateClientRepository.listGateClients();

  return {
    data: clients.map(toPublicGateClient),
  };
}

// Function สร้าง Gate client ใน service flow
export async function createGateClient(
  body: unknown,
  auth?: AccessTokenPayload,
  context: SecurityAuditRequestContext = EMPTY_SECURITY_AUDIT_CONTEXT
): Promise<GateClientSecretResponse> {
  const input = parseWithSchema(createGateClientBodySchema, body);
  const clientId = input.client_id ?? (await generateUniqueClientId());
  const actorId = getActorId(auth);

  if (await gateClientRepository.clientIdExists(clientId)) {
    throw new ApiError(
      409,
      "GATE_CLIENT_ID_ALREADY_EXISTS",
      "Gate client id already exists."
    );
  }

  const clientSecret = generateGateClientSecret();

  return withTransaction(async (transaction) => {
    const client = await gateClientRepository.createGateClient(
      {
        client_id: clientId,
        name: input.name,
        secret_hash: await hashPassword(clientSecret),
        status: input.status,
        created_by: actorId,
        updated_by: actorId,
      },
      transaction
    );
    const actorSnapshot = await findActorSnapshot(actorId, transaction);

    await writeSecurityAuditLog(
      {
        event_type: SECURITY_AUDIT_EVENT_TYPE.GATE_CLIENT_CREATED,
        outcome: SECURITY_AUDIT_OUTCOME.SUCCESS,
        actor_type: "admin",
        actor_account_id: actorId,
        actor_username: actorSnapshot.username,
        actor_full_name: actorSnapshot.full_name,
        ip_address: context.ip_address,
        user_agent: context.user_agent,
        request_id: context.request_id,
        metadata: {
          targetType: "gate_client",
          targetClientId: client.client_id,
          after: { name: client.name, status: client.status },
        },
      },
      transaction
    );

    return {
      message: "Gate client created successfully. Save client_secret now because it will not be shown again.",
      ...toPublicGateClient(client),
      client_secret: clientSecret,
    };
  });
}

// Function อัปเดต Gate client ใน service flow
export async function updateGateClient(
  clientIdParam: unknown,
  body: unknown,
  auth?: AccessTokenPayload,
  context: SecurityAuditRequestContext = EMPTY_SECURITY_AUDIT_CONTEXT
): Promise<GateClientMutationResponse> {
  const existingClient = await requireGateClient(clientIdParam);
  // Snapshot ก่อนแก้ไขจริง กัน repository (โดยเฉพาะ mock ของ test) คืน object เดิมแทน fresh copy
  const existingClientBeforeUpdate = { ...existingClient };
  const input = parseWithSchema(updateGateClientBodySchema, body);
  const actorId = getActorId(auth);

  return withTransaction(async (transaction) => {
    const client = await gateClientRepository.updateGateClient(
      existingClient.client_id,
      {
        name: input.name,
        status: input.status,
        updated_by: actorId,
      },
      transaction
    );
    const diff = diffChangedFields(existingClientBeforeUpdate, client, ["name", "status"]);

    if (diff) {
      const actorSnapshot = await findActorSnapshot(actorId, transaction);

      await writeSecurityAuditLog(
        {
          event_type: SECURITY_AUDIT_EVENT_TYPE.GATE_CLIENT_UPDATED,
          outcome: SECURITY_AUDIT_OUTCOME.SUCCESS,
          actor_type: "admin",
          actor_account_id: actorId,
          actor_username: actorSnapshot.username,
          actor_full_name: actorSnapshot.full_name,
          ip_address: context.ip_address,
          user_agent: context.user_agent,
          request_id: context.request_id,
          metadata: {
            targetType: "gate_client",
            targetClientId: client.client_id,
            before: diff.before,
            after: diff.after,
          },
        },
        transaction
      );
    }

    return {
      message: "Gate client updated successfully.",
      ...toPublicGateClient(client),
    };
  });
}

// Function จัดการ rotate Gate client secret ใน service flow
export async function rotateGateClientSecret(
  clientIdParam: unknown,
  auth?: AccessTokenPayload,
  context: SecurityAuditRequestContext = EMPTY_SECURITY_AUDIT_CONTEXT
): Promise<GateClientSecretResponse> {
  const existingClient = await requireGateClient(clientIdParam);
  const clientSecret = generateGateClientSecret();
  const actorId = getActorId(auth);

  return withTransaction(async (transaction) => {
    const client = await gateClientRepository.updateGateClientSecret(
      existingClient.client_id,
      await hashPassword(clientSecret),
      actorId,
      transaction
    );
    const actorSnapshot = await findActorSnapshot(actorId, transaction);

    // ห้ามเก็บ secret เดิม/ใหม่หรือ hash ของมันใน metadata เด็ดขาด — เก็บแค่ว่า client ไหนถูก rotate
    await writeSecurityAuditLog(
      {
        event_type: SECURITY_AUDIT_EVENT_TYPE.GATE_CLIENT_SECRET_ROTATED,
        outcome: SECURITY_AUDIT_OUTCOME.SUCCESS,
        actor_type: "admin",
        actor_account_id: actorId,
        actor_username: actorSnapshot.username,
        actor_full_name: actorSnapshot.full_name,
        ip_address: context.ip_address,
        user_agent: context.user_agent,
        request_id: context.request_id,
        metadata: {
          targetType: "gate_client",
          targetClientId: client.client_id,
        },
      },
      transaction
    );

    return {
      message: "Gate client secret rotated successfully. Save client_secret now because it will not be shown again.",
      ...toPublicGateClient(client),
      client_secret: clientSecret,
    };
  });
}

// Function ดึงรายการ roles ใน service flow
export async function listRoles(): Promise<AdminRoleListResponse> {
  const admins = await accountRepository.listAdmins();

  return {
    data: ADMIN_PERMISSION_LEVELS.map((level, index) => ({
      key: level,
      name: level
        .split("_")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" "),
      order: index,
      admins: admins
        .filter((account) => account.permission_level === level)
        .map((account) => ({
          id: account.id,
          username: account.username,
          full_name: account.full_name,
          position: account.position,
          status: account.status,
          email: account.email,
          phone: account.phone,
          created_at: account.created_at,
          updated_at: account.updated_at,
        })),
    })),
  };
}

// Function สร้าง admin account ใน service flow
export async function createAdminAccount(
  body: unknown,
  auth?: AccessTokenPayload,
  context: SecurityAuditRequestContext = EMPTY_SECURITY_AUDIT_CONTEXT
) {
  const input = parseWithSchema(createAdminAccountBodySchema, body);
  const actorId = getActorId(auth);

  const actorAccount = await assertCanCreateAdminLevel(
    input.permission_level,
    auth
  );
  await assertPermissionsGrantable(actorAccount, input.permissions);
  assertPermissionDependenciesSatisfied(input.permissions);
  // บัญชีใหม่ current permissions = [] จึงเท่ากับตรวจ grant ครั้งแรกของกลุ่ม owner-only โดยอัตโนมัติ
  assertOwnerOnlyPermissionsUnchanged(actorAccount, [], input.permissions);
  await assertAdminUsernameAvailable(input.username);

  return withTransaction(async (transaction) => {
    const account = await adminSettingsRepository.createAdmin(
      {
        username: input.username,
        password_hash: await hashPassword(input.password),
        role: "admin",
        status: input.status,
        full_name: input.full_name,
        position: input.position ?? null,
        email: input.email ?? null,
        phone: input.phone ?? null,
        permission_level: input.permission_level,
        created_by: actorId,
      },
      transaction
    );

    await permissionRepository.replaceAccountPermissions(
      account.id,
      input.permissions,
      transaction
    );

    await writeSecurityAuditLog(
      {
        event_type: SECURITY_AUDIT_EVENT_TYPE.ADMIN_ACCOUNT_CREATED,
        outcome: SECURITY_AUDIT_OUTCOME.SUCCESS,
        actor_type: "admin",
        actor_account_id: actorId,
        actor_username: actorAccount.username,
        actor_full_name: actorAccount.full_name,
        ip_address: context.ip_address,
        user_agent: context.user_agent,
        request_id: context.request_id,
        metadata: {
          targetType: "admin_account",
          targetAccountId: account.id,
          targetUsername: account.username,
          after: {
            full_name: account.full_name,
            status: account.status,
            permission_level: account.permission_level,
            permissions: input.permissions,
          },
        },
      },
      transaction
    );

    return {
      message: "Admin account created successfully.",
      account: accountRepository.sanitizeAccount(account),
      ...(await getAccountPermissions(account, transaction)),
    };
  });
}

// Function ดึง admin user permissions ใน service flow
export async function getAdminUserPermissions(
  accountIdParam: unknown,
  auth?: AccessTokenPayload
): Promise<AccountPermissionsResponse> {
  const account = await requireAdminAccount(accountIdParam);

  await assertCanReadAdminPermissions(account, auth);

  return getAccountPermissions(account);
}

// Function อัปเดต admin user permissions ใน service flow
export async function updateAdminUserPermissions(
  accountIdParam: unknown,
  body: unknown,
  auth?: AccessTokenPayload,
  context: SecurityAuditRequestContext = EMPTY_SECURITY_AUDIT_CONTEXT
): Promise<AccountPermissionsResponse & { message: string }> {
  const input = parseWithSchema(updateAccountPermissionsBodySchema, body);
  const account = await requireAdminAccount(accountIdParam);

  const actorAccount = await assertCanManageAdminPermissions(
    account,
    input.permission_level,
    auth
  );
  await assertPermissionsGrantable(actorAccount, input.permissions);
  assertPermissionDependenciesSatisfied(input.permissions);

  return withTransaction(async (transaction) => {
    // Lock แถว target ไว้ก่อน re-check hierarchy แล้วเขียนจริง กัน Race เมื่อ 2 admin แก้ target เดียวกันพร้อมกัน
    // (เช่น Owner ลดระดับ target ขณะอีก manager กำลังเช็ค hierarchy จาก state เก่า) — fetch ใหม่หลัง lock เพื่อเช็คกฎล่าสุด
    await transaction.$queryRaw`SELECT id FROM accounts WHERE id = ${account.id} FOR UPDATE`;

    const freshTarget = await adminSettingsRepository.findAdminById(account.id, transaction);

    if (!freshTarget) {
      throw new ApiError(404, "ADMIN_NOT_FOUND", "Admin account not found.");
    }

    // Snapshot ก่อนแก้ไขจริง — updatePermissionLevel/updateStatus ด้านล่างจะ mutate freshTarget ถ้าไม่ snapshot ไว้ก่อน
    const targetBeforeUpdate = { ...freshTarget };

    if (
      !canManagePermissionLevel(
        actorAccount.permission_level,
        freshTarget.permission_level
      )
    ) {
      throw new ApiError(
        403,
        "TARGET_PERMISSION_LEVEL_NOT_MANAGEABLE",
        "Admin cannot update permissions for an equal or higher permission level."
      );
    }

    // เช็คหลัง Lock ด้วยชุด permission ล่าสุดของ target เพื่อกัน Race เดียวกับข้างบน (ดู comment ของ assertOwnerOnlyPermissionsUnchanged)
    const currentPermissions = await permissionRepository.listByAccountId(
      account.id,
      transaction
    );

    assertOwnerOnlyPermissionsUnchanged(
      actorAccount,
      currentPermissions,
      input.permissions
    );

    let updatedAccount = await adminSettingsRepository.updatePermissionLevel(
      account.id,
      input.permission_level,
      transaction
    );

    if (input.status !== undefined) {
      updatedAccount = await accountRepository.updateStatus(
        account.id,
        input.status,
        transaction
      );
    }

    await permissionRepository.replaceAccountPermissions(
      account.id,
      input.permissions,
      transaction
    );
    await sessionRepository.revokeActiveByAccountId(account.id, transaction);

    const actorSnapshot = await findActorSnapshot(actorAccount.id, transaction);
    const baseLog = {
      actor_type: "admin" as const,
      actor_account_id: actorAccount.id,
      actor_username: actorSnapshot.username,
      actor_full_name: actorSnapshot.full_name,
      ip_address: context.ip_address,
      user_agent: context.user_agent,
      request_id: context.request_id,
    };
    const sortedCurrentPermissions = [...currentPermissions].sort();
    const sortedNextPermissions = [...input.permissions].sort();
    const permissionsChanged =
      targetBeforeUpdate.permission_level !== input.permission_level ||
      sortedCurrentPermissions.join(",") !== sortedNextPermissions.join(",");

    if (permissionsChanged) {
      await writeSecurityAuditLog(
        {
          ...baseLog,
          event_type: SECURITY_AUDIT_EVENT_TYPE.ADMIN_PERMISSIONS_CHANGED,
          outcome: SECURITY_AUDIT_OUTCOME.SUCCESS,
          metadata: {
            targetType: "admin_account",
            targetAccountId: account.id,
            targetUsername: targetBeforeUpdate.username,
            before: {
              permission_level: targetBeforeUpdate.permission_level,
              permissions: sortedCurrentPermissions,
            },
            after: {
              permission_level: input.permission_level,
              permissions: sortedNextPermissions,
            },
          },
        },
        transaction
      );
    }

    if (input.status !== undefined && input.status !== targetBeforeUpdate.status) {
      await writeSecurityAuditLog(
        {
          ...baseLog,
          event_type: SECURITY_AUDIT_EVENT_TYPE.ADMIN_STATUS_CHANGED,
          outcome: SECURITY_AUDIT_OUTCOME.SUCCESS,
          metadata: {
            targetType: "admin_account",
            targetAccountId: account.id,
            targetUsername: targetBeforeUpdate.username,
            before: { status: targetBeforeUpdate.status },
            after: { status: input.status },
          },
        },
        transaction
      );
    }

    return {
      message: "Admin permissions updated successfully. Active sessions were revoked.",
      ...(await getAccountPermissions(updatedAccount, transaction)),
    };
  });
}

// Function อัปเดตข้อมูลพื้นฐาน (full_name/position/email/phone) ของแอดมินอีกคนหนึ่ง — permission_level/permissions ยังคงแก้ผ่าน updateAdminUserPermissions เท่านั้น
export async function updateAdminAccount(
  accountIdParam: unknown,
  body: unknown,
  auth?: AccessTokenPayload,
  context: SecurityAuditRequestContext = EMPTY_SECURITY_AUDIT_CONTEXT
) {
  const input = parseWithSchema(updateAdminAccountBodySchema, body);
  const account = await requireAdminAccount(accountIdParam);
  // Snapshot ก่อนแก้ไขจริง กัน repository (โดยเฉพาะ mock ของ test) คืน object เดิมแทน fresh copy
  const accountBeforeUpdate = { ...account };

  await assertCanManageAdminAccount(account, auth);

  return withTransaction(async (transaction) => {
    const updatedAccount = await adminSettingsRepository.updateAdminAccount(
      account.id,
      {
        full_name: input.full_name,
        position: input.position,
        email: input.email,
        phone: input.phone,
      },
      transaction
    );
    const diff = diffChangedFields(accountBeforeUpdate, updatedAccount, [
      "full_name",
      "position",
      "email",
      "phone",
    ]);

    if (diff) {
      const actorAccount = await requireAdminActor(auth);
      const actorSnapshot = await findActorSnapshot(actorAccount.id, transaction);

      await writeSecurityAuditLog(
        {
          event_type: SECURITY_AUDIT_EVENT_TYPE.ADMIN_ACCOUNT_UPDATED,
          outcome: SECURITY_AUDIT_OUTCOME.SUCCESS,
          actor_type: "admin",
          actor_account_id: actorAccount.id,
          actor_username: actorSnapshot.username,
          actor_full_name: actorSnapshot.full_name,
          ip_address: context.ip_address,
          user_agent: context.user_agent,
          request_id: context.request_id,
          metadata: {
            targetType: "admin_account",
            targetAccountId: account.id,
            targetUsername: updatedAccount.username,
            before: diff.before,
            after: diff.after,
          },
        },
        transaction
      );
    }

    return {
      message: "Admin account updated successfully.",
      account: accountRepository.sanitizeAccount(updatedAccount),
    };
  });
}

// Function รีเซ็ตรหัสผ่านของแอดมินอีกคนหนึ่ง — revoke active session ทั้งหมดของเป้าหมาย เหมือน resetPassword ของ Worker (admin-workers.service.ts)
export async function resetAdminPassword(
  accountIdParam: unknown,
  body: unknown,
  auth?: AccessTokenPayload,
  context: SecurityAuditRequestContext = EMPTY_SECURITY_AUDIT_CONTEXT
): Promise<{ message: string }> {
  const { new_password: newPassword } = parseWithSchema(
    resetPasswordBodySchema,
    body
  );
  const account = await requireAdminAccount(accountIdParam);

  await assertCanManageAdminAccount(account, auth);

  return withTransaction(async (transaction) => {
    await accountRepository.updatePassword(
      account.id,
      await hashPassword(newPassword),
      transaction
    );
    await sessionRepository.revokeActiveByAccountId(account.id, transaction);

    const actorAccount = await requireAdminActor(auth);
    const actorSnapshot = await findActorSnapshot(actorAccount.id, transaction);

    await writeSecurityAuditLog(
      {
        event_type: SECURITY_AUDIT_EVENT_TYPE.ACCOUNT_PASSWORD_RESET,
        outcome: SECURITY_AUDIT_OUTCOME.SUCCESS,
        actor_type: "admin",
        actor_account_id: actorAccount.id,
        actor_username: actorSnapshot.username,
        actor_full_name: actorSnapshot.full_name,
        ip_address: context.ip_address,
        user_agent: context.user_agent,
        request_id: context.request_id,
        metadata: {
          targetType: "admin_account",
          targetAccountId: account.id,
          targetUsername: account.username,
        },
      },
      transaction
    );

    return {
      message: "Admin password reset successfully. Active sessions were revoked.",
    };
  });
}
