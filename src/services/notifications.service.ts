// Import Library
import type { Response } from "express";
// Import Config
import { getAccessTokenExpiresInSeconds, getAccessTokenRefreshThresholdSeconds } from "../config/auth.config";
// Import Middleware
import { toPascalCasePayload } from "../middlewares/api-case.middleware";
// Import Utils
import { buildWorkerQueueSocketPayload } from "../utils/worker-payload";
import { logger } from "../utils/logger";
// Import Types
import type { AccessTokenPayload } from "../types/auth.type";
import type { NotificationAudience, NotificationClient, RealtimeNotificationEvent, WorkerStatusChangedInput } from "../types/notifications.type";
import type { TicketJobAssignmentDto, VehicleWorkReadinessDto, WorkerQueueEntryDto } from "../types/worker.type";

/* -------------------------------------- Config -------------------------------------- */

const clients = new Map<number, NotificationClient>();
let clientSequence = 1;

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจว่า receive event ใน service flow
function canReceiveEvent(
  auth: AccessTokenPayload,
  audience?: NotificationAudience
): boolean {
  if (!audience) {
    return true;
  }

  if (audience.account_ids?.includes(auth.account_id)) {
    return true;
  }

  if (audience.roles?.includes(auth.role)) {
    return true;
  }

  return false;
}

// Function เขียน SSE event ไปยัง client — ครอบด้วย try/catch เพราะ response อาจถูก destroy ไปแล้ว
// (client หลุดกะทันหันก่อน "close" event) เขียนซ้ำจะ throw จนทำให้ loop client อื่นใน publishNotification หยุดไปด้วย
function writeSseEvent(
  response: Response,
  eventName: string,
  data: unknown
): void {
  try {
    const now = new Date();
    // server_time/server_time_unix_ms ให้ frontend คำนวณ offset เวลาได้เหมือนฝั่ง REST/WebSocket — ใส่เฉพาะตอน data เป็น plain object
    const eventData =
      data && typeof data === "object" && !Array.isArray(data)
        ? { ...data, server_time: now.toISOString(), server_time_unix_ms: now.getTime() }
        : data;

    response.write(`event: ${eventName}\n`);
    response.write(`data: ${JSON.stringify(toPascalCasePayload(eventData))}\n\n`);
  } catch (error) {
    logger.error("Failed to write SSE event.", { error });
  }
}

// Function หา SSE client ที่ผูกกับ session_id ที่ระบุ — ใช้ตอนต้อง target connection เดียวเจาะจง (เช่น
// แจ้ง session เดิมว่าถูก revoke) ต่างจาก publishNotification ที่ broadcast กว้างแบบ audience filter
function findClientBySessionId(sessionId: number): NotificationClient | undefined {
  for (const client of clients.values()) {
    if (client.auth.session_id === sessionId) {
      return client;
    }
  }

  return undefined;
}

// Function เคลียร์ client ออกจาก in-memory list เมื่อ connection ปิดหรือหลุด กัน heartbeat/timer ค้าง
function removeSseClient(clientId: number): void {
  const client = clients.get(clientId);

  if (client) {
    clearInterval(client.heartbeat);

    if (client.tokenRefreshTimer) {
      clearTimeout(client.tokenRefreshTimer);
    }

    clients.delete(clientId);
  }
}

// Function ตั้ง timer ล่วงหน้าครั้งเดียวต่อ SSE connection เพื่อส่งสัญญาณเตือนก่อน access token ของ
// connection นี้ใกล้หมดอายุ — ใช้ exp ที่รู้อยู่แล้วตอน subscribe ไม่ต้อง poll/query ซ้ำ คู่ขนานกับ
// scheduleAccessTokenRefreshReminder ของ worker.socket.ts ครอบคลุมเคส Admin เปิดหน้า dashboard
// ค้างไว้ (SSE ต่ออยู่) นานๆ โดยไม่มี REST call อื่นเกิดขึ้นเลย
function scheduleAccessTokenRefreshReminder(clientId: number, exp: number | undefined): void {
  if (typeof exp !== "number") {
    return;
  }

  const thresholdSeconds = getAccessTokenRefreshThresholdSeconds();
  const accessTokenLifetimeMs = getAccessTokenExpiresInSeconds() * 1000;

  const fireReminder = (): void => {
    const client = clients.get(clientId);

    if (!client) {
      return;
    }

    writeSseEvent(client.response, "TOKEN_NEARING_EXPIRY", {});
    // ยิงซ้ำทุกรอบอายุ access token ต่อไปเรื่อยๆ สมมติว่า client เรียก /refresh ตามสัญญาณทุกครั้ง
    client.tokenRefreshTimer = setTimeout(fireReminder, accessTokenLifetimeMs);
  };

  const nowSeconds = Math.floor(Date.now() / 1000);
  const initialDelayMs = Math.max(0, (exp - nowSeconds - thresholdSeconds) * 1000);
  const client = clients.get(clientId);

  if (client) {
    client.tokenRefreshTimer = setTimeout(fireReminder, initialDelayMs);
  }
}

// Function จัดการ subscribe admin events ใน service flow
export function subscribeAdminEvents(
  response: Response,
  auth: AccessTokenPayload
): void {
  const clientId = clientSequence;
  clientSequence += 1;

  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders?.();

  writeSseEvent(response, "connected", {
    message: "Notification stream connected.",
    connected_at: new Date().toISOString(),
  });

  const heartbeat = setInterval(() => {
    try {
      response.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    } catch (error) {
      logger.error("Failed to write SSE heartbeat.", { error });
    }
  }, 25000);

  clients.set(clientId, {
    id: clientId,
    auth,
    response,
    heartbeat,
  });

  scheduleAccessTokenRefreshReminder(clientId, auth.exp);

  // ดัก "error" ไว้ด้วย ไม่ใช่แค่ "close" — ไม่งั้น error ที่ไม่มี listener จะ throw แบบ uncaught จน crash ทั้ง process
  response.req.on("close", () => removeSseClient(clientId));
  response.req.on("error", () => removeSseClient(clientId));
  response.on("error", () => removeSseClient(clientId));
}

// Function ส่ง event ไปยัง SSE connection ของ session หนึ่งโดยเฉพาะแล้วปิด connection นั้นทันที — ใช้ตอน
// session ถูก revoke แบบเจาะจง (เช่น login เครื่องใหม่ทับ session เดิม) ให้ Frontend ของเครื่องเดิมรู้ผลทันที
// ไม่ต้องรอ REST เรียกครั้งถัดไปแล้วโดน 401 คืน false เฉยๆ ถ้าไม่พบ connection ที่ตรงกัน (เช่น เครื่องเดิมไม่ได้เปิด
// SSE ค้างไว้อยู่แล้ว) เป็น best-effort ไม่ throw
export function sendAdminSseEventToSession(
  sessionId: number,
  eventName: string,
  data: unknown
): boolean {
  const client = findClientBySessionId(sessionId);

  if (!client) {
    return false;
  }

  writeSseEvent(client.response, eventName, data);
  removeSseClient(client.id);
  client.response.end();

  return true;
}

// Function กระจาย event notification ใน service flow
export function publishNotification(event: RealtimeNotificationEvent): void {
  const payload = {
    type: event.type,
    title: event.title,
    message: event.message,
    payload: event.payload ?? null,
    occurred_at: new Date().toISOString(),
  };

  for (const client of clients.values()) {
    if (!canReceiveEvent(client.auth, event.audience)) {
      continue;
    }

    writeSseEvent(client.response, event.type, payload);
  }
}

// Function สร้าง worker status changed payload ใน service flow
function buildWorkerStatusChangedPayload(input: {
  workerCode: string | null;
  queue: WorkerQueueEntryDto | null | undefined;
  reason: string;
  assignment?: TicketJobAssignmentDto | null;
  team_scan_readiness?: Pick<VehicleWorkReadinessDto, "is_ready"> | null;
  extraPayload?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    worker_code: input.workerCode,
    queue: buildWorkerQueueSocketPayload(
      input.queue,
      input.workerCode,
      input.assignment ?? null,
      input.team_scan_readiness ?? null
    ),
    reason: input.reason,
    ...(input.extraPayload ?? {}),
  };
}

// Function กระจาย event admin worker status changed ใน service flow
export function publishAdminWorkerStatusChanged(
  input: WorkerStatusChangedInput
): void {
  publishNotification({
    type: "WORKER_STATUS_CHANGED",
    title: input.title,
    message: input.message,
    payload: buildWorkerStatusChangedPayload(input),
    audience: {
      roles: ["admin"],
    },
  });
}
