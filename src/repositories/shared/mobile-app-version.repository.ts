// Import Utils
import { client, requireMapped } from "./repository-utils";
// Import Types
import type { DbConnection } from "../../types/shared/common.type";
import type { MobileAppVersionCreateInput, MobileAppVersionDto, MobileAppVersionUpdateInput } from "../../types/shared/mobile-app-version.type";

/* -------------------------------------- Functions -------------------------------------- */

function toMobileAppVersionIsoString(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function mapMobileAppVersion(record: {
  id: number;
  version: string;
  buildNumber: number;
  releaseAt: Date | null;
  androidDownloadUrl: string | null;
  iosDownloadUrl: string | null;
  forceUpdateAt: Date | null;
  releaseNotificationAt: Date | null;
  releaseNotificationSentAt: Date | null;
  forceUpdateNotificationSentAt: Date | null;
  releaseMessage: string | null;
  releaseNotes: string | null;
  createdBy: number | null;
  updatedBy: number | null;
  createdAt: Date;
  updatedAt: Date;
} | null): MobileAppVersionDto | null {
  if (!record) {
    return null;
  }

  return {
    id: record.id,
    version: record.version,
    build_number: record.buildNumber,
    release_at: toMobileAppVersionIsoString(record.releaseAt),
    android_download_url: record.androidDownloadUrl,
    ios_download_url: record.iosDownloadUrl,
    force_update_at: toMobileAppVersionIsoString(record.forceUpdateAt),
    release_notification_at: toMobileAppVersionIsoString(record.releaseNotificationAt),
    release_notification_sent_at: toMobileAppVersionIsoString(record.releaseNotificationSentAt),
    force_update_notification_sent_at: toMobileAppVersionIsoString(
      record.forceUpdateNotificationSentAt,
    ),
    release_message: record.releaseMessage,
    release_notes: record.releaseNotes,
    created_by: record.createdBy,
    updated_by: record.updatedBy,
    created_at: toMobileAppVersionIsoString(record.createdAt) as string,
    updated_at: toMobileAppVersionIsoString(record.updatedAt) as string,
  };
}

// Function ดึงทุก Version ที่ยังไม่ถูกลบ (ไม่มี Delete API) เรียงจาก BuildNumber มากไปน้อย
export async function listMobileAppVersions(
  connection?: DbConnection
): Promise<MobileAppVersionDto[]> {
  const records = await client(connection).mobileAppVersion.findMany({
    orderBy: {
      buildNumber: "desc",
    },
  });

  return records
    .map((record) => mapMobileAppVersion(record))
    .filter((record): record is MobileAppVersionDto => record !== null);
}

// Function ค้นหา mobile app version ตาม ID จาก DB
export async function findMobileAppVersionById(
  id: number,
  connection?: DbConnection
): Promise<MobileAppVersionDto | null> {
  const record = await client(connection).mobileAppVersion.findUnique({
    where: {
      id,
    },
  });

  return mapMobileAppVersion(record);
}

// Function ตรวจ BuildNumber ซ้ำก่อนสร้าง Version ใหม่ (BuildNumber เป็นตัวหลักสำหรับ compare
// ต้อง unique เสมอ ไม่งั้น resolve current version จะกำกวม)
export async function findMobileAppVersionByBuildNumber(
  buildNumber: number,
  connection?: DbConnection
): Promise<MobileAppVersionDto | null> {
  const record = await client(connection).mobileAppVersion.findUnique({
    where: {
      buildNumber,
    },
  });

  return mapMobileAppVersion(record);
}

// Function สร้าง mobile app version ใหม่ลง DB
export async function createMobileAppVersion(
  input: MobileAppVersionCreateInput,
  connection?: DbConnection
): Promise<MobileAppVersionDto> {
  const record = await client(connection).mobileAppVersion.create({
    data: {
      version: input.version,
      buildNumber: input.build_number,
      releaseAt: input.release_at ? new Date(input.release_at) : null,
      androidDownloadUrl: input.android_download_url ?? null,
      iosDownloadUrl: input.ios_download_url ?? null,
      forceUpdateAt: input.force_update_at ? new Date(input.force_update_at) : null,
      releaseNotificationAt: input.release_notification_at
        ? new Date(input.release_notification_at)
        : null,
      releaseMessage: input.release_message ?? null,
      releaseNotes: input.release_notes ?? null,
      createdBy: input.created_by ?? null,
      updatedBy: input.updated_by ?? null,
    },
  });

  return requireMapped(mapMobileAppVersion(record), "Mobile app version", "create");
}

// Function อัปเดตข้อมูล mobile app version จาก DB
export async function updateMobileAppVersion(
  id: number,
  input: MobileAppVersionUpdateInput,
  connection?: DbConnection
): Promise<MobileAppVersionDto> {
  const record = await client(connection).mobileAppVersion.update({
    where: {
      id,
    },
    data: {
      version: input.version,
      buildNumber: input.build_number,
      releaseAt:
        input.release_at === undefined
          ? undefined
          : input.release_at
            ? new Date(input.release_at)
            : null,
      androidDownloadUrl: input.android_download_url,
      iosDownloadUrl: input.ios_download_url,
      forceUpdateAt:
        input.force_update_at === undefined
          ? undefined
          : input.force_update_at
            ? new Date(input.force_update_at)
            : null,
      releaseNotificationAt:
        input.release_notification_at === undefined
          ? undefined
          : input.release_notification_at
            ? new Date(input.release_notification_at)
            : null,
      releaseNotificationSentAt:
        input.release_notification_sent_at === undefined
          ? undefined
          : input.release_notification_sent_at
            ? new Date(input.release_notification_sent_at)
            : null,
      forceUpdateNotificationSentAt:
        input.force_update_notification_sent_at === undefined
          ? undefined
          : input.force_update_notification_sent_at
            ? new Date(input.force_update_notification_sent_at)
            : null,
      releaseMessage: input.release_message,
      releaseNotes: input.release_notes,
      updatedBy: input.updated_by ?? null,
    },
  });

  return requireMapped(mapMobileAppVersion(record), "Mobile app version", "update");
}

// Function claim สิทธิ์ส่ง FCM ล่วงหน้า (Release Notification) แบบ atomic (WHERE ...IS NULL) กันส่งซ้ำ
// คืน Date ที่ claim ได้ (null ถ้ามีคนอื่น claim ไปก่อน) ใช้เป็น key ตอนเรียก clearReleaseNotificationSent
export async function claimReleaseNotificationSent(
  id: number,
  connection?: DbConnection
): Promise<Date | null> {
  const claimedAt = new Date();
  const result = await client(connection).mobileAppVersion.updateMany({
    where: {
      id,
      releaseNotificationSentAt: null,
    },
    data: {
      releaseNotificationSentAt: claimedAt,
    },
  });

  return result.count === 1 ? claimedAt : null;
}

// Function ยกเลิก claim "ส่งแล้ว" ของ Release Notification แบบ atomic เมื่อส่ง FCM จริงไม่สำเร็จ เปิดทางให้ retry ใหม่ได้
// เช็ค releaseNotificationSentAt ต้องตรงกับ claimedAt เพื่อกัน race กับ claim ใหม่ที่อาจเกิดขึ้นระหว่างนั้น
export async function clearReleaseNotificationSent(
  id: number,
  claimedAt: Date,
  connection?: DbConnection
): Promise<void> {
  await client(connection).mobileAppVersion.updateMany({
    where: {
      id,
      releaseNotificationSentAt: claimedAt,
    },
    data: {
      releaseNotificationSentAt: null,
    },
  });
}

// Function ทำเครื่องหมายว่าส่ง FCM บังคับอัปเดต (Force Update Notification) แล้วแบบ atomic — คนละ
// tracker กับ Release Notification เพราะเป็นคนละข้อความคนละเวลากัน
export async function claimForceUpdateNotificationSent(
  id: number,
  connection?: DbConnection
): Promise<Date | null> {
  const claimedAt = new Date();
  const result = await client(connection).mobileAppVersion.updateMany({
    where: {
      id,
      forceUpdateNotificationSentAt: null,
    },
    data: {
      forceUpdateNotificationSentAt: claimedAt,
    },
  });

  return result.count === 1 ? claimedAt : null;
}

// Function ยกเลิก Mark "ส่งแล้ว" ของ Force-Update Notification แบบ atomic — คู่ขนานกับ
// clearReleaseNotificationSent ด้านบน ใช้เมื่อ Claim ไปแล้วแต่ส่ง FCM จริงไม่สำเร็จ
export async function clearForceUpdateNotificationSent(
  id: number,
  claimedAt: Date,
  connection?: DbConnection
): Promise<void> {
  await client(connection).mobileAppVersion.updateMany({
    where: {
      id,
      forceUpdateNotificationSentAt: claimedAt,
    },
    data: {
      forceUpdateNotificationSentAt: null,
    },
  });
}
