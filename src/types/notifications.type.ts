// Import Library
import type { Response } from "express";
// Import Types
import type { AccessTokenPayload } from "./auth.type";
import type { TicketJobAssignmentDto, VehicleWorkReadinessDto, WorkerQueueEntryDto, WorkerSocketEventType } from "./worker.type";

// Type กลุ่มผู้รับแจ้งเตือน Admin (role/account/permission)
export type NotificationAudience = {
  account_ids?: number[];
  roles?: string[];
};

// Type event แจ้งเตือนที่ส่งให้ Admin ทาง SSE
export type RealtimeNotificationEvent = {
  type: string;
  title: string;
  message: string;
  notification_key?: string | null;
  lang?: string | null;
  payload?: unknown;
  audience?: NotificationAudience;
};

// Type input สำหรับกระจาย event ไป Admin และ Worker
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

// Type SSE client ของ Admin หนึ่ง connection
export type NotificationClient = {
  id: number;
  auth: AccessTokenPayload;
  response: Response;
  heartbeat: NodeJS.Timeout;
  // timer เตือนก่อน access token ของ connection นี้หมดอายุ
  tokenRefreshTimer?: NodeJS.Timeout;
};

// Type ส่วน DTO แจ้งเตือนของ worker
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

// Type ส่วน Repository input สำหรับบันทึกแจ้งเตือนของ worker
export interface CreateWorkerNotificationInput {
  worker_id: number;
  type: string;
  notification_key?: string | null;
  lang?: string | null;
  title: string;
  message: string;
  payload?: unknown;
}

// Type ส่วน Response ของรายการแจ้งเตือนของ worker
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

// Type input สำหรับแจ้ง Admin ว่าสถานะ worker เปลี่ยน
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
