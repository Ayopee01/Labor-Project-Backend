// Import Services
import { publishNotification } from "../notifications.service";
// Import Repositories
import * as masterWorkerRepository from "../../repositories/shared/master-worker.repository";
import * as ticketWorkerRepository from "../../repositories/shared/ticket-worker.repository";
import * as workerNotificationRepository from "../../repositories/shared/worker-notification.repository";
// Import Services
import { sendWorkerPushNotificationByWorkerIds } from "./worker-push.service";
// Import Utils
import { sendWorkerSocketEvent } from "../../websockets/worker.socket";
import { logger } from "../../utils/logger";
import { buildLocalizedNotification } from "../../utils/notification-localization";
// Import Validation
import { parseWithSchema } from "../../validation/parser";
import { paginationQuerySchema } from "../../validation/schemas";
// Import Utils
import ApiError from "../../utils/api-error";
// Import Types
import type { AccessTokenPayload } from "../../types/auth.type";
import type { PublishRealtimeEventInput, WorkerNotificationListResponse } from "../../types/notifications.type";
import type { DbConnection } from "../../types/shared/common.type";
import type { BoothJobDto, WorkerSocketEventType } from "../../types/worker.type";

// Function กระจาย Event แบบ Realtime ไปหา Admin (publishNotification) และ Worker (บันทึกแจ้งเตือน, Push, Socket)
export function publishRealtimeEvent(input: PublishRealtimeEventInput): void {
  const payload = input.payload ?? {};

  if (input.admin) {
    publishNotification({
      type: input.type,
      title: input.title,
      message: input.message,
      payload,
      audience: {
        roles: ["admin"],
      },
    });
  }

  const workerIds = [...new Set(input.worker_ids ?? [])];
  const workerPayload = input.worker_payload ?? payload;

  if (workerIds.length > 0) {
    void masterWorkerRepository.listByIds(workerIds).then((workers) => {
      const workerById = new Map(workers.map((worker) => [worker.id, worker]));

      persistWorkerNotifications(
        workerIds.map((workerId) => {
          const localized = buildWorkerNotification({
            type: input.type,
            lang: workerById.get(workerId)?.lang,
            notification_key: input.notification_key,
            notification_params: input.notification_params,
            payload: workerPayload,
            fallbackTitle: input.title,
            fallbackMessage: input.message,
          });

          return {
            worker_id: workerId,
            type: input.type,
            notification_key: localized.key,
            lang: localized.lang,
            title: localized.title,
            message: localized.message,
            payload: workerPayload,
          };
        }),
      );
    }).catch((error: unknown) => {
      logger.error("Failed to localize worker notifications.", { error });
    });

    void sendWorkerPushNotificationByWorkerIds({
      worker_ids: workerIds,
      type: input.type,
      title: input.title,
      message: input.message,
      notification_key: input.notification_key,
      notification_params: input.notification_params,
      payload: workerPayload,
    }).catch((error: unknown) => {
      logger.error("Failed to send worker push notification.", { error });
    });
  }

  for (const workerId of workerIds) {
    sendWorkerSocketEvent(
      workerId,
      input.type as WorkerSocketEventType,
      workerPayload,
      {
        push: false,
        notificationKey: input.notification_key,
        notificationParams: input.notification_params,
        fallbackTitle: input.title,
        fallbackMessage: input.message,
      },
    );
  }
}

// Function หา Worker ที่ต้องได้รับแจ้งเตือนผลของ Ticket — คืนเฉพาะ worker id (ไม่รวม Admin เพราะ
// MasterWorker.id เป็นคนละ id space กับ Account.id — Admin ถูกแจ้งแยกผ่าน publishRealtimeEvent ด้วย admin: true)
export async function resolveTicketResultAudience(
  ticket: BoothJobDto,
  connection?: DbConnection
): Promise<number[]> {
  // Roster เป็นระดับ Business Ticket (market job) ไม่ใช่ระดับ Booth แล้ว
  const ticketWorkers = await ticketWorkerRepository.listTicketWorkers(ticket.market_job_id, connection);
  const receiverIds = new Set<number>();

  ticketWorkers.forEach((worker) => receiverIds.add(worker.worker_id));

  return Array.from(receiverIds);
}

// Function บันทึก notification ของ worker หนึ่งรายการลง DB แบบ fire-and-forget (ไม่รอผลลัพธ์)
export function persistWorkerNotification(input: {
  worker_id: number;
  type: string;
  notification_key: string;
  lang: string;
  title: string;
  message: string;
  payload?: unknown;
}): void {
  void workerNotificationRepository.createWorkerNotification(input).catch((error) => {
    logger.error("Failed to persist worker notification.", { error });
  });
}

// Function บันทึก notification ของ worker หลายรายการลง DB แบบ fire-and-forget (ไม่รอผลลัพธ์)
export function persistWorkerNotifications(inputs: Array<{
  worker_id: number;
  type: string;
  notification_key: string;
  lang: string;
  title: string;
  message: string;
  payload?: unknown;
}>): void {
  void workerNotificationRepository.createWorkerNotifications(inputs).catch((error) => {
    logger.error("Failed to persist worker notifications.", { error });
  });
}

// Function ดึงรายการ notification ของ worker ที่ login อยู่แบบแบ่งหน้า
export async function listWorkerNotifications(
  query: unknown,
  auth?: AccessTokenPayload
): Promise<WorkerNotificationListResponse> {
  if (!auth || !auth.account_id || auth.role !== "worker") {
    throw new ApiError(401, "INVALID_TOKEN", "Invalid or expired token.");
  }

  const { page, limit } = parseWithSchema(paginationQuerySchema, query);
  const result = await workerNotificationRepository.listWorkerNotifications(
    auth.account_id,
    page,
    limit,
  );

  return {
    data: result.items.map((item) => ({
      id: item.id,
      type: item.type,
      notification_key: item.notification_key,
      lang: item.lang,
      title: item.title,
      message: item.message,
      notification: {
        key: item.notification_key,
        lang: item.lang,
        title: item.title,
        message: item.message,
      },
      payload: item.payload,
      read_at: item.read_at,
      created_at: item.created_at,
    })),
    pagination: {
      page,
      limit,
      total: result.total,
      total_pages: Math.ceil(result.total / limit),
    },
  };
}

// Function สร้างข้อความ notification ของ worker ตามภาษาและ key ที่กำหนด (localized)
export function buildWorkerNotification(input: {
  type: string;
  lang?: string | null;
  notification_key?: string | null;
  notification_params?: Record<string, unknown>;
  payload?: Record<string, unknown>;
  fallbackTitle: string;
  fallbackMessage: string;
}) {
  return buildLocalizedNotification({
    type: input.type,
    lang: input.lang,
    key: input.notification_key,
    params: input.notification_params ?? input.payload,
    fallbackTitle: input.fallbackTitle,
    fallbackMessage: input.fallbackMessage,
  });
}
