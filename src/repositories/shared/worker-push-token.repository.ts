// Import Library
import { createHash } from "crypto";
// Import Config
import { prisma } from "../../db/prisma";
// Import Utils
import { client } from "./repository-utils";
// Import Types
import type { WorkerPushToken } from "@prisma/client";
import type { DbConnection } from "../../types/shared/common.type";
import type { PushPlatform, UpsertWorkerPushTokenInput, WorkerPushTokenDto } from "../../types/notifications.type";

/* -------------------------------------- Functions -------------------------------------- */

function toPushTokenIsoString(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function normalizePushPlatform(value?: string | null): PushPlatform {
  const platform = value?.trim().toLowerCase();

  if (platform === "android" || platform === "ios" || platform === "web") {
    return platform;
  }

  return "unknown";
}

function hashFcmToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function mapWorkerPushToken(record: WorkerPushToken): WorkerPushTokenDto {
  return {
    id: record.id,
    worker_id: record.workerId,
    worker_code: record.workerCode,
    session_id: record.sessionId,
    device_id: record.deviceId,
    platform: normalizePushPlatform(record.platform),
    fcm_token: record.fcmToken,
    fcm_token_hash: record.fcmTokenHash,
    is_active: record.isActive,
    last_seen_at: record.lastSeenAt.toISOString(),
    revoked_at: toPushTokenIsoString(record.revokedAt),
    created_at: record.createdAt.toISOString(),
    updated_at: record.updatedAt.toISOString(),
  };
}

// Function สร้างหรืออัปเดต push token ของ worker ตาม worker + device + platform
export async function upsertWorkerPushToken(
  input: UpsertWorkerPushTokenInput,
  connection?: DbConnection,
): Promise<WorkerPushTokenDto> {
  const db = connection ?? prisma;
  const platform = normalizePushPlatform(input.platform);
  const now = new Date();
  const data = {
    workerId: input.worker_id,
    workerCode: input.worker_code,
    sessionId: input.session_id ?? null,
    deviceId: input.device_id,
    platform,
    fcmToken: input.fcm_token,
    fcmTokenHash: hashFcmToken(input.fcm_token),
    isActive: true,
    revokedAt: null,
    lastSeenAt: now,
    updatedAt: now,
  };

  const record = await db.workerPushToken.upsert({
    where: {
      workerId_deviceId_platform: {
        workerId: input.worker_id,
        deviceId: input.device_id,
        platform,
      },
    },
    update: data,
    create: {
      ...data,
      createdAt: now,
    },
  });

  return mapWorkerPushToken(record);
}

// Function ดึง push token ที่ active ของ worker หลายคนตาม worker_code
export async function listActiveTokensByWorkerCodes(
  workerCodes: string[],
  connection?: DbConnection,
): Promise<WorkerPushTokenDto[]> {
  const uniqueWorkerCodes = [...new Set(workerCodes.filter(Boolean))];

  if (uniqueWorkerCodes.length === 0) {
    return [];
  }

  const records = await client(connection).workerPushToken.findMany({
    where: {
      workerCode: {
        in: uniqueWorkerCodes,
      },
      isActive: true,
    },
  });

  return records.map(mapWorkerPushToken);
}

// Function ดึง token ที่ active ทั้งหมด ใช้ broadcast แจ้งทุก worker เช่น Mobile App Version update
export async function listAllActiveTokens(
  connection?: DbConnection,
): Promise<WorkerPushTokenDto[]> {
  const records = await client(connection).workerPushToken.findMany({
    where: {
      isActive: true,
    },
  });

  return records.map(mapWorkerPushToken);
}

// Function ดึง push token ที่ active ของ session นี้
export async function listActiveTokensBySessionId(
  sessionId: number,
  connection?: DbConnection,
): Promise<WorkerPushTokenDto[]> {
  const records = await client(connection).workerPushToken.findMany({
    where: {
      sessionId,
      isActive: true,
    },
  });

  return records.map(mapWorkerPushToken);
}

// Function ยกเลิก push token ที่ active ทั้งหมดของ session นี้
export async function revokeBySessionId(
  sessionId: number,
  connection?: DbConnection,
): Promise<number> {
  const revokedAt = new Date();
  const result = await client(connection).workerPushToken.updateMany({
    where: {
      sessionId,
      isActive: true,
    },
    data: {
      isActive: false,
      revokedAt,
      updatedAt: revokedAt,
    },
  });

  return result.count;
}

// Function ยกเลิก push token ตาม fcm token hash หลายตัว
export async function revokeByTokenHashes(
  fcmTokenHashes: string[],
  connection?: DbConnection,
): Promise<number> {
  const uniqueHashes = [...new Set(fcmTokenHashes.filter(Boolean))];

  if (uniqueHashes.length === 0) {
    return 0;
  }

  const revokedAt = new Date();
  const result = await client(connection).workerPushToken.updateMany({
    where: {
      fcmTokenHash: {
        in: uniqueHashes,
      },
      isActive: true,
    },
    data: {
      isActive: false,
      revokedAt,
      updatedAt: revokedAt,
    },
  });

  return result.count;
}
