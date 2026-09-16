import type { Response } from "express";
import type { AccessTokenPayload } from "./auth.type";
import type { TicketJobAssignmentDto, VehicleWorkReadinessDto, WorkerQueueEntryDto, WorkerSocketEventType } from "./worker.type";

export type NotificationAudience = {
  account_ids?: number[];
  roles?: string[];
};

export type RealtimeNotificationEvent = {
  type: string;
  title: string;
  message: string;
  notification_key?: string | null;
  lang?: string | null;
  payload?: unknown;
  audience?: NotificationAudience;
};

export type PublishRealtimeEventInput = {
  type: WorkerSocketEventType | string;
  title: string;
  message: string;
  notification_key?: string;
  notification_params?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  worker_payload?: Record<string, unknown>;
  admin?: boolean;
  worker_ids?: number[];
};

export type NotificationClient = {
  id: number;
  auth: AccessTokenPayload;
  response: Response;
  heartbeat: NodeJS.Timeout;
  // Timer เตือนล่วงหน้าก่อน access token ของ connection นี้ใกล้หมดอายุ — schedule ตอน subscribe จาก exp
  // ที่รู้อยู่แล้ว คู่ขนานกับ tokenRefreshTimer ของ WorkerSocket ใน worker.type.ts
  tokenRefreshTimer?: NodeJS.Timeout;
};

export interface WorkerNotificationDto {
  id: number;
  worker_id: number;
  type: string;
  notification_key: string | null;
  lang: string;
  title: string;
  message: string;
  payload: unknown;
  read_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateWorkerNotificationInput {
  worker_id: number;
  type: string;
  notification_key?: string | null;
  lang?: string | null;
  title: string;
  message: string;
  payload?: unknown;
}

export interface WorkerNotificationListResponse {
  data: Array<{
    id: number;
    type: string;
    notification_key: string | null;
    lang: string;
    title: string;
    message: string;
    notification: {
      key: string | null;
      lang: string;
      title: string;
      message: string;
    };
    payload: unknown;
    read_at: string | null;
    created_at: string;
  }>;
  pagination: {
    page: number;
    limit: number;
    total: number;
    total_pages: number;
  };
}

// Type ค่า platform ของ client ที่เป็นเจ้าของ FCM token
export type PushPlatform = "android" | "ios" | "web" | "unknown";

// Type DTO ของตาราง worker_push_tokens สำหรับส่ง push notification ไป Mobile
export interface WorkerPushTokenDto {
  id: number;
  worker_id: number;
  worker_code: string;
  session_id: number | null;
  device_id: string;
  platform: PushPlatform;
  fcm_token: string;
  fcm_token_hash: string;
  is_active: boolean;
  last_seen_at: string;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

// Type input ของ repository สำหรับลงทะเบียนหรือ refresh FCM token ของ worker
export interface UpsertWorkerPushTokenInput {
  worker_id: number;
  worker_code: string;
  session_id?: number | null;
  device_id: string;
  platform?: string | null;
  fcm_token: string;
}

// Type response หลัง Worker Mobile ลงทะเบียน push token
export interface WorkerPushRegistrationResponse {
  statusCode: number;
  code: string;
  message: string;
  worker_code: string;
  device_id: string;
  platform: PushPlatform;
}

// Type input สำหรับส่ง push notification หนึ่ง event ไปยัง WorkerCode หนึ่งคนหรือหลายคน
export interface WorkerPushEventInput {
  worker_codes: string[];
  type: string;
  title: string;
  message: string;
  notification_key?: string | null;
  lang?: string | null;
  payload?: Record<string, unknown>;
}

export type WorkerStatusChangedInput = {
  title: string;
  message: string;
  workerCode: string | null;
  queue: WorkerQueueEntryDto | null | undefined;
  reason: string;
  assignment?: TicketJobAssignmentDto | null;
  team_scan_readiness?: Pick<VehicleWorkReadinessDto, "is_ready"> | null;
  extraPayload?: Record<string, unknown>;
};
