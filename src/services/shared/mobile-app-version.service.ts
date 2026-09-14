// Import Repositories
import * as mobileAppVersionRepository from "../../repositories/shared/mobile-app-version.repository";
// Import Config
import { EMPTY_SECURITY_AUDIT_CONTEXT } from "../../config/security-audit.config";
// Import Services
import { sendWorkerPushNotificationToAllActive } from "./worker-push.service";
// Import Queues
import { removeMobileAppForceUpdateNotification, removeMobileAppReleaseNotification, scheduleMobileAppForceUpdateNotification, scheduleMobileAppReleaseNotification } from "../../queues/worker-queue";
// Import Services
import { diffChangedFields, writeSecurityAuditLog } from "./security-audit-log.service";
// Import Config
import { withTransaction } from "../../db/prisma";
// Import Types
import { SECURITY_AUDIT_EVENT_TYPE, SECURITY_AUDIT_OUTCOME } from "../../types/shared/security-audit-log.type";
import type { MobileAppVersionCreateInput, MobileAppVersionDto, MobileAppVersionStatus, MobileAppVersionUpdateInput } from "../../types/shared/mobile-app-version.type";
import type { SecurityAuditRequestContext } from "../../types/shared/security-audit-log.type";

// Actor snapshot ที่ caller resolve มาให้แล้ว — ไฟล์นี้ตั้งใจไม่มี accountRepository เอง
// เพื่อไม่ให้ shared service ผูกกับ Account model โดยตรง
export interface SecurityAuditActorSnapshot {
  actor_account_id: number | null;
  username: string | null;
  full_name: string | null;
}

const EMPTY_ACTOR_SNAPSHOT: SecurityAuditActorSnapshot = {
  actor_account_id: null,
  username: null,
  full_name: null,
};

// Import Validation
import { parseId, parseWithSchema } from "../../validation/parser";
import { createMobileAppVersionBodySchema, mobileAppVersionCheckQuerySchema, updateMobileAppVersionBodySchema } from "../../validation/schemas";

// Import Utils
import ApiError from "../../utils/api-error";
import { logger } from "../../utils/logger";
import { formatBangkokDisplayDateTime } from "../../utils/time";

/* -------------------------------------- Types -------------------------------------- */

export interface AdminMobileAppVersionSummary extends MobileAppVersionDto {
  status: MobileAppVersionStatus;
}

export interface AdminMobileAppVersionOverviewResponse {
  current: AdminMobileAppVersionSummary | null;
  scheduled: AdminMobileAppVersionSummary | null;
  history: AdminMobileAppVersionSummary[];
}

export type MobileAppVersionCheckStatus =
  | "UP_TO_DATE"
  | "UPDATE_AVAILABLE"
  | "UPDATE_REQUIRED"
  | "NO_VERSION_CONFIGURED";

export interface MobileAppVersionCheckResponse {
  status: MobileAppVersionCheckStatus;
  update_available: boolean;
  force_update: boolean;
  can_skip: boolean;
  latest: {
    version: string;
    build_number: number;
    download_url: string | null;
  } | null;
  policy: {
    force_update_at: string | null;
  } | null;
  release_message: {
    message: string | null;
    release_notes: string | null;
  } | null;
}

/* -------------------------------------- Functions -------------------------------------- */

// Function หาเวลาที่ Version เริ่มมีผลใช้งานจริง — ใช้ ForceUpdateAt ถ้ามี ไม่งั้นใช้ CreatedAt
function resolveActivationTime(version: MobileAppVersionDto): number {
  const base = version.force_update_at ?? version.created_at;

  return new Date(base).getTime();
}

// Function กลาง หา Effective Version ณ เวลาปัจจุบัน (Single Source of Truth ของ Admin GET, Mobile
// Version Check, และ FCM Worker — ห้าม duplicate logic นี้ที่อื่น)
// เลือก Version ที่ ActivationTime <= now แล้วเอา BuildNumber สูงสุด โดยเทียบเวลาสดทุกครั้ง ไม่พึ่ง BullMQ
function resolveEffectiveMobileAppVersion(
  versions: MobileAppVersionDto[],
  now: Date,
): MobileAppVersionDto | null {
  const nowMs = now.getTime();
  const activated = versions.filter((version) => resolveActivationTime(version) <= nowMs);

  if (activated.length === 0) {
    return null;
  }

  return activated.reduce((best, version) =>
    version.build_number > best.build_number ? version : best,
  );
}

// Function จัดกลุ่ม Version เป็น current/scheduled/history ตามเวลาปัจจุบัน — derive สดทุกครั้ง
// ไม่เก็บเป็น status column เพราะเวลาผ่านไปแล้วไม่มีใครมา sync จะทำให้ค้างผิดได้
function classifyMobileAppVersions(
  versions: MobileAppVersionDto[],
  now: Date,
): {
  current: MobileAppVersionDto | null;
  scheduled: MobileAppVersionDto | null;
  history: MobileAppVersionDto[];
} {
  const current = resolveEffectiveMobileAppVersion(versions, now);
  const nowMs = now.getTime();
  const notActivated = versions.filter((version) => resolveActivationTime(version) > nowMs);
  // Scheduled ที่แสดงบนบอร์ด Admin คือตัวที่ใกล้ถึงเวลาที่สุด (Version ถัดไปที่จะมีผล)
  const scheduled =
    notActivated.length > 0
      ? notActivated.reduce((soonest, version) =>
          resolveActivationTime(version) < resolveActivationTime(soonest) ? version : soonest,
        )
      : null;
  const history = versions
    .filter((version) => version.id !== current?.id && version.id !== scheduled?.id)
    .sort((left, right) => right.build_number - left.build_number);

  return { current, scheduled, history };
}

function resolveMobileAppVersionStatus(
  versionId: number,
  classified: ReturnType<typeof classifyMobileAppVersions>,
): MobileAppVersionStatus {
  if (classified.current?.id === versionId) {
    return "current";
  }

  if (classified.scheduled?.id === versionId) {
    return "scheduled";
  }

  return "history";
}

function toAdminSummary(
  version: MobileAppVersionDto,
  status: MobileAppVersionStatus,
): AdminMobileAppVersionSummary {
  return {
    ...version,
    status,
  };
}

/* -------------------------------------- Notification Shared Helpers -------------------------------------- */

// Function แปลง ForceUpdateAt เป็นวันที่/เวลาไทย (Asia/Bangkok) สำหรับใส่ใน Release Notification
// ถ้าไม่มี ForceUpdateAt คืน object ว่าง
function buildForceUpdateDisplayParams(
  forceUpdateAt: string | null,
): { force_update_date?: string; force_update_time?: string } {
  if (!forceUpdateAt) {
    return {};
  }

  const display = formatBangkokDisplayDateTime(forceUpdateAt);
  const [datePart, timePart] = display.split(" ");

  return {
    force_update_date: datePart,
    force_update_time: timePart?.slice(0, 5),
  };
}

/* -------------------------------------- Release Notification (แจ้งเตือนล่วงหน้า) -------------------------------------- */

// Function ประกอบและส่ง FCM Release Notification — Title/Message มาตรฐานจาก notification-localization
// (แปลตามภาษาของแต่ละ Worker) ต่อท้ายด้วย ReleaseMessage ที่ Admin พิมพ์เอง (free text)
async function sendReleaseNotificationFcm(version: MobileAppVersionDto): Promise<boolean> {
  const timingParams = buildForceUpdateDisplayParams(version.force_update_at);

  try {
    await sendWorkerPushNotificationToAllActive({
      type: "APP_VERSION_UPDATE",
      notification_params: {
        version: version.version,
        ...timingParams,
      },
      fallbackTitle: "New app version available",
      fallbackMessage: timingParams.force_update_date
        ? `Version ${version.version} is ready to update, and will be required starting ${timingParams.force_update_date} at ${timingParams.force_update_time}.`
        : `Version ${version.version} is ready to update.`,
      appendMessage: version.release_message,
      payload: {
        version: version.version,
        build_number: String(version.build_number),
        action: "CHECK_APP_VERSION",
      },
    });

    return true;
  } catch (error) {
    logger.error("Failed to send mobile app version release FCM notification.", { error });

    return false;
  }
}

// Function ส่ง Release Notification ทันที — claim ReleaseNotificationSentAt แบบ atomic ก่อนส่งจริง
// เพื่อกัน race ที่หลายจุดพยายามส่งพร้อมกัน ถ้า claim สำเร็จแต่ส่ง FCM ไม่สำเร็จ ต้อง clear กลับเป็น
// null เสมอ ไม่งั้นจะค้างว่า "ส่งแล้ว" ทั้งที่ไม่มีใครได้รับจริง และจะไม่มีทาง resend ได้อีก
async function sendReleaseNotificationNow(
  version: MobileAppVersionDto,
): Promise<MobileAppVersionDto> {
  const claimedAt = await mobileAppVersionRepository.claimReleaseNotificationSent(version.id);

  if (claimedAt) {
    const sent = await sendReleaseNotificationFcm(version);

    if (!sent) {
      await mobileAppVersionRepository.clearReleaseNotificationSent(version.id, claimedAt);
    }
  }

  return (
    (await mobileAppVersionRepository.findMobileAppVersionById(version.id)) ?? version
  );
}

// Function sync สถานะ Release Notification ให้ตรงกับ ReleaseNotificationAt ปัจจุบัน — ลบ delayed
// job เดิมก่อนเสมอ แล้วส่งทันทีถ้าไม่มีเวลาตั้งไว้ หรือ schedule ใหม่ถ้ามี ไม่ทำอะไรถ้าส่งไปแล้ว
async function syncReleaseNotification(
  version: MobileAppVersionDto,
): Promise<MobileAppVersionDto> {
  await removeMobileAppReleaseNotification(version.id);

  if (version.release_notification_sent_at) {
    return version;
  }

  if (!version.release_notification_at) {
    return sendReleaseNotificationNow(version);
  }

  const delayMs = Math.max(
    0,
    new Date(version.release_notification_at).getTime() - Date.now(),
  );

  await scheduleMobileAppReleaseNotification(version.id, delayMs);

  return version;
}

// Function ที่ BullMQ delayed job เรียกตอนถึง ReleaseNotificationAt — โหลด record ล่าสุดจาก DB
// เสมอ เพราะ Admin อาจ PATCH เปลี่ยน/ยกเลิกไปแล้วก่อนถึงเวลาจริง
export async function sendMobileAppReleaseNotification(
  mobileAppVersionId: number,
): Promise<void> {
  const version = await mobileAppVersionRepository.findMobileAppVersionById(
    mobileAppVersionId,
  );

  if (!version || version.release_notification_sent_at) {
    return;
  }

  // ป้องกัน race จาก 2 PATCH ที่แย่งกัน schedule ด้วย jobId เดียวกัน — เช็คเวลาล่าสุดจาก DB ซ้ำ
  // ก่อนส่งเสมอ ถ้ายังไม่ถึงเวลา (ถูกเลื่อนออกไป) ให้ reschedule ใหม่แทนที่จะส่งตามเวลาเก่า
  if (
    version.release_notification_at &&
    new Date(version.release_notification_at).getTime() > Date.now()
  ) {
    await syncReleaseNotification(version);
    return;
  }

  await sendReleaseNotificationNow(version);
}

/* -------------------------------------- Force-Update Notification (บังคับอัปเดตแล้ว) -------------------------------------- */

// Function ประกอบและส่ง FCM บังคับอัปเดต — ข้อความมาตรฐานของระบบ ไม่ต่อท้ายด้วย ReleaseMessage
async function sendForceUpdateNotificationFcm(version: MobileAppVersionDto): Promise<boolean> {
  try {
    await sendWorkerPushNotificationToAllActive({
      type: "APP_VERSION_FORCE_UPDATE",
      notification_params: {
        version: version.version,
      },
      fallbackTitle: "Update is now required",
      fallbackMessage: `A new app version ${version.version} is now available. Please update to continue.`,
      payload: {
        version: version.version,
        build_number: String(version.build_number),
        action: "CHECK_APP_VERSION",
      },
    });

    return true;
  } catch (error) {
    logger.error("Failed to send mobile app version force-update FCM notification.", { error });

    return false;
  }
}

// Function ส่ง Force-Update Notification จริง — claim ForceUpdateNotificationSentAt แบบ atomic
// ก่อนส่งเสมอ (คนละ tracker กับ Release Notification) ถ้าส่ง FCM ไม่สำเร็จต้อง clear กลับเป็น null เสมอ
async function sendForceUpdateNotificationNow(
  version: MobileAppVersionDto,
): Promise<MobileAppVersionDto> {
  const claimedAt = await mobileAppVersionRepository.claimForceUpdateNotificationSent(
    version.id,
  );

  if (claimedAt) {
    const sent = await sendForceUpdateNotificationFcm(version);

    if (!sent) {
      await mobileAppVersionRepository.clearForceUpdateNotificationSent(version.id, claimedAt);
    }
  }

  return (
    (await mobileAppVersionRepository.findMobileAppVersionById(version.id)) ?? version
  );
}

// Function sync สถานะ Force-Update Notification ให้ตรงกับ ForceUpdateAt ปัจจุบัน — ลบ job เดิม
// ก่อนเสมอ แล้ว schedule ใหม่ถ้ายังตั้งไว้ ไม่ทำอะไรถ้าส่งไปแล้วหรือไม่มี ForceUpdateAt
async function syncForceUpdateNotification(
  version: MobileAppVersionDto,
): Promise<MobileAppVersionDto> {
  await removeMobileAppForceUpdateNotification(version.id);

  if (version.force_update_notification_sent_at) {
    return version;
  }

  if (!version.force_update_at) {
    return version;
  }

  const delayMs = Math.max(0, new Date(version.force_update_at).getTime() - Date.now());

  await scheduleMobileAppForceUpdateNotification(version.id, delayMs);

  return version;
}

// Function ที่ BullMQ delayed job เรียกตอนถึง ForceUpdateAt — โหลด record ล่าสุดเสมอ
// เหตุผลเดียวกับ Release Notification (Admin อาจ PATCH เปลี่ยน/ถอดไปแล้วก่อนถึงเวลาจริง)
export async function sendMobileAppForceUpdateNotification(
  mobileAppVersionId: number,
): Promise<void> {
  const version = await mobileAppVersionRepository.findMobileAppVersionById(
    mobileAppVersionId,
  );

  if (!version || !version.force_update_at || version.force_update_notification_sent_at) {
    return;
  }

  // ป้องกัน race ชนิดเดียวกับ Release Notification ด้านบน — เช็คเวลาจริงซ้ำจาก DB ก่อนส่งเสมอ
  if (new Date(version.force_update_at).getTime() > Date.now()) {
    await syncForceUpdateNotification(version);
    return;
  }

  await sendForceUpdateNotificationNow(version);
}

/* -------------------------------------- Admin Functions -------------------------------------- */

// Function ดึง Current/Scheduled/History ทั้งหมดสำหรับหน้า Admin Settings > Mobile Application
export async function getAdminMobileAppVersionOverview(): Promise<AdminMobileAppVersionOverviewResponse> {
  const versions = await mobileAppVersionRepository.listMobileAppVersions();
  const classified = classifyMobileAppVersions(versions, new Date());

  return {
    current: classified.current ? toAdminSummary(classified.current, "current") : null,
    scheduled: classified.scheduled ? toAdminSummary(classified.scheduled, "scheduled") : null,
    history: classified.history.map((version) => toAdminSummary(version, "history")),
  };
}

// Function สร้าง Mobile App Version ใหม่ — ถ้ามี ForceUpdateAt ในอนาคตจะเป็น Scheduled ทันที
// ไม่กระทบ Worker จนกว่าจะถึงเวลา (ไม่มี Publish endpoint แยก)
export async function createMobileAppVersion(
  body: unknown,
  actorId: number | null,
  actorSnapshot: SecurityAuditActorSnapshot = EMPTY_ACTOR_SNAPSHOT,
  context: SecurityAuditRequestContext = EMPTY_SECURITY_AUDIT_CONTEXT,
): Promise<AdminMobileAppVersionSummary> {
  const input = parseWithSchema(createMobileAppVersionBodySchema, body);
  const conflict = await mobileAppVersionRepository.findMobileAppVersionByBuildNumber(
    input.build_number,
  );

  if (conflict) {
    throw new ApiError(
      409,
      "BUILD_NUMBER_ALREADY_EXISTS",
      "BuildNumber already exists.",
    );
  }

  const createInput: MobileAppVersionCreateInput = {
    version: input.version,
    build_number: input.build_number,
    release_at: input.release_at ?? null,
    android_download_url: input.android_download_url ?? null,
    ios_download_url: input.ios_download_url ?? null,
    force_update_at: input.force_update_at ?? null,
    release_notification_at: input.release_notification_at ?? null,
    release_message: input.release_message ?? null,
    release_notes: input.release_notes ?? null,
    created_by: actorId,
    updated_by: actorId,
  };
  // create + audit write ต้องอยู่ transaction เดียวกัน เพื่อ rollback พร้อมกันถ้า audit เขียนไม่สำเร็จ
  // (ไม่ให้เกิด version ที่สร้างจริงแต่ไม่มีหลักฐานใน audit log) — sync notification อยู่นอก
  // transaction เพราะเป็น I/O ภายนอก (BullMQ/FCM) ไม่ใช่ DB write ที่ต้อง atomic ร่วมด้วย
  const created = await withTransaction(async (transaction) => {
    const record = await mobileAppVersionRepository.createMobileAppVersion(
      createInput,
      transaction
    );

    await writeSecurityAuditLog(
      {
        event_type: SECURITY_AUDIT_EVENT_TYPE.MOBILE_APP_VERSION_CREATED,
        outcome: SECURITY_AUDIT_OUTCOME.SUCCESS,
        actor_type: "admin",
        actor_account_id: actorSnapshot.actor_account_id,
        actor_username: actorSnapshot.username,
        actor_full_name: actorSnapshot.full_name,
        ip_address: context.ip_address,
        user_agent: context.user_agent,
        request_id: context.request_id,
        metadata: {
          targetType: "mobile_app_version",
          targetVersionId: record.id,
          after: {
            version: record.version,
            build_number: record.build_number,
            force_update_at: record.force_update_at,
          },
        },
      },
      transaction
    );

    return record;
  });

  await syncReleaseNotification(created);
  await syncForceUpdateNotification(created);

  const afterSync =
    (await mobileAppVersionRepository.findMobileAppVersionById(created.id)) ?? created;
  const versions = await mobileAppVersionRepository.listMobileAppVersions();
  const classified = classifyMobileAppVersions(versions, new Date());

  return toAdminSummary(afterSync, resolveMobileAppVersionStatus(created.id, classified));
}

// Function แก้ไข Mobile App Version — Version/BuildNumber แก้ได้เฉพาะตอนยัง Scheduled เท่านั้น
// กันไม่ให้ History ผิดเพี้ยนย้อนหลัง
export async function updateMobileAppVersion(
  idParam: unknown,
  body: unknown,
  actorId: number | null,
  actorSnapshot: SecurityAuditActorSnapshot = EMPTY_ACTOR_SNAPSHOT,
  context: SecurityAuditRequestContext = EMPTY_SECURITY_AUDIT_CONTEXT,
): Promise<AdminMobileAppVersionSummary> {
  const id = parseId(idParam);
  const existing = await mobileAppVersionRepository.findMobileAppVersionById(id);

  if (!existing) {
    throw new ApiError(404, "MOBILE_APP_VERSION_NOT_FOUND", "Mobile app version not found.");
  }

  // Snapshot ก่อนแก้ไขจริง กัน repository (โดยเฉพาะ mock ของ test) คืน object เดิมแทน fresh copy
  const existingBeforeUpdate = { ...existing };
  const input = parseWithSchema(updateMobileAppVersionBodySchema, body);
  const versionsBeforeUpdate = await mobileAppVersionRepository.listMobileAppVersions();
  const statusBeforeUpdate = resolveMobileAppVersionStatus(
    id,
    classifyMobileAppVersions(versionsBeforeUpdate, new Date()),
  );
  const changesIdentity =
    input.version !== undefined || input.build_number !== undefined;

  if (changesIdentity && statusBeforeUpdate !== "scheduled") {
    throw new ApiError(
      409,
      "MOBILE_APP_VERSION_LOCKED",
      "Version and BuildNumber can only be changed while the version is still scheduled.",
    );
  }

  // เช็คบน merged state (ค่าเดิม + ค่าที่ patch มา) เพราะ PATCH อาจแก้แค่ฝั่งเดียวของคู่นี้
  const mergedForceUpdateAt =
    input.force_update_at !== undefined ? input.force_update_at : existing.force_update_at;
  const mergedNotificationAt =
    input.release_notification_at !== undefined
      ? input.release_notification_at
      : existing.release_notification_at;

  if (
    mergedNotificationAt &&
    mergedForceUpdateAt &&
    new Date(mergedNotificationAt).getTime() > new Date(mergedForceUpdateAt).getTime()
  ) {
    throw new ApiError(
      400,
      "RELEASE_NOTIFICATION_AT_AFTER_FORCE_UPDATE_AT",
      "release_notification_at must not be later than force_update_at.",
    );
  }

  if (input.build_number !== undefined && input.build_number !== existing.build_number) {
    const conflict = await mobileAppVersionRepository.findMobileAppVersionByBuildNumber(
      input.build_number,
    );

    if (conflict && conflict.id !== id) {
      throw new ApiError(
        409,
        "BUILD_NUMBER_ALREADY_EXISTS",
        "BuildNumber already exists.",
      );
    }
  }

  const updateInput: MobileAppVersionUpdateInput = {
    version: input.version,
    build_number: input.build_number,
    release_at: input.release_at,
    android_download_url: input.android_download_url,
    ios_download_url: input.ios_download_url,
    force_update_at: input.force_update_at,
    release_notification_at: input.release_notification_at,
    release_message: input.release_message,
    release_notes: input.release_notes,
    updated_by: actorId,
  };

  // update + diff + audit write ต้องอยู่ transaction เดียวกัน (เหตุผลเดียวกับ createMobileAppVersion)
  // diff คำนวณจาก updatedRecord ได้เลย เพราะ notification sync ไม่แตะ field ที่ diff ตรวจ
  const updated = await withTransaction(async (transaction) => {
    const updatedRecord = await mobileAppVersionRepository.updateMobileAppVersion(
      id,
      updateInput,
      transaction
    );
    const changeDiff = diffChangedFields(existingBeforeUpdate, updatedRecord, [
      "version",
      "build_number",
      "release_at",
      "android_download_url",
      "ios_download_url",
      "force_update_at",
      "release_notification_at",
      "release_message",
      "release_notes",
    ]);

    if (changeDiff) {
      await writeSecurityAuditLog(
        {
          event_type: SECURITY_AUDIT_EVENT_TYPE.MOBILE_APP_VERSION_UPDATED,
          outcome: SECURITY_AUDIT_OUTCOME.SUCCESS,
          actor_type: "admin",
          actor_account_id: actorSnapshot.actor_account_id,
          actor_username: actorSnapshot.username,
          actor_full_name: actorSnapshot.full_name,
          ip_address: context.ip_address,
          user_agent: context.user_agent,
          request_id: context.request_id,
          metadata: {
            targetType: "mobile_app_version",
            targetVersionId: id,
            before: changeDiff.before,
            after: changeDiff.after,
          },
        },
        transaction
      );
    }

    return updatedRecord;
  });

  // ReleaseNotificationAt เปลี่ยน: sync ใหม่ถ้ายังไม่เคยส่ง, หรือแค่เคลียร์ job ค้างถ้าส่งไปแล้ว
  // (ห้ามส่งซ้ำอัตโนมัติ)
  if (input.release_notification_at !== undefined) {
    if (updated.release_notification_sent_at) {
      await removeMobileAppReleaseNotification(id);
    } else {
      await syncReleaseNotification(updated);
    }
  }

  // ForceUpdateAt เปลี่ยน: sync Force-Update Notification ใหม่ด้วยเหตุผลเดียวกัน
  if (input.force_update_at !== undefined) {
    const latest =
      (await mobileAppVersionRepository.findMobileAppVersionById(id)) ?? updated;

    if (latest.force_update_notification_sent_at) {
      await removeMobileAppForceUpdateNotification(id);
    } else {
      await syncForceUpdateNotification(latest);
    }
  }

  const finalVersion =
    (await mobileAppVersionRepository.findMobileAppVersionById(id)) ?? updated;
  const versionsAfterUpdate = await mobileAppVersionRepository.listMobileAppVersions();
  const classifiedAfterUpdate = classifyMobileAppVersions(versionsAfterUpdate, new Date());

  return toAdminSummary(finalVersion, resolveMobileAppVersionStatus(id, classifiedAfterUpdate));
}

/* -------------------------------------- Mobile Functions -------------------------------------- */

// Function ตรวจ Version สำหรับ Mobile App ตอนเปิดแอป — Public ไม่ต้อง Login
// ใช้เวลา server (new Date()) เป็น Source of Truth เสมอ ห้าม Mobile ใช้เวลาเครื่องตัดสิน
export async function checkMobileAppVersionForClient(
  query: unknown,
): Promise<MobileAppVersionCheckResponse> {
  const input = parseWithSchema(mobileAppVersionCheckQuerySchema, query);
  const versions = await mobileAppVersionRepository.listMobileAppVersions();
  const effective = resolveEffectiveMobileAppVersion(versions, new Date());

  if (!effective) {
    return {
      status: "NO_VERSION_CONFIGURED",
      update_available: false,
      force_update: false,
      can_skip: true,
      latest: null,
      policy: null,
      release_message: null,
    };
  }

  const downloadUrl =
    input.platform === "android"
      ? effective.android_download_url
      : input.platform === "ios"
        ? effective.ios_download_url
        : null;
  const latest = {
    version: effective.version,
    build_number: effective.build_number,
    download_url: downloadUrl,
  };
  const policy = effective.force_update_at
    ? { force_update_at: effective.force_update_at }
    : null;
  const releaseMessage =
    effective.release_message || effective.release_notes
      ? {
          message: effective.release_message,
          release_notes: effective.release_notes,
        }
      : null;

  // ClientBuild ที่ >= Effective ถือว่าล่าสุดแล้วเสมอ ห้าม downgrade แม้ Client Build จะสูงกว่า Server
  const clientBuildNumber = input.build_number ?? 0;

  if (clientBuildNumber >= effective.build_number) {
    return {
      status: "UP_TO_DATE",
      update_available: false,
      force_update: false,
      can_skip: true,
      latest,
      policy,
      release_message: releaseMessage,
    };
  }

  // มี ForceUpdateAt = บังคับ Update เสมอ — ServerTime ผ่าน ForceUpdateAt ไปแล้วแน่นอนที่จุดนี้
  // เพราะ resolveEffectiveMobileAppVersion เลือก Version ได้ก็ต่อเมื่อ ActivationTime ผ่านไปแล้วเท่านั้น
  const forceUpdateRequired = effective.force_update_at !== null;

  return {
    status: forceUpdateRequired ? "UPDATE_REQUIRED" : "UPDATE_AVAILABLE",
    update_available: true,
    force_update: forceUpdateRequired,
    can_skip: !forceUpdateRequired,
    latest,
    policy,
    release_message: releaseMessage,
  };
}
