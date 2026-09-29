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

// Config SSE client ที่เชื่อมต่ออยู่และตัวนับ id
const clients = new Map<number, NotificationClient>();
let clientSequence = 1;

/* -------------------------------------- Functions -------------------------------------- */

// Function ตรวจว่า client นี้ควรได้รับ event ตาม audience หรือไม่
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

// Function เขียน SSE event ไปยัง client (catch error เผื่อ connection หลุดไปแล้ว)
function writeSseEvent(
  response: Response,
  eventName: string,
  data: unknown
): void {
  try {
    const now = new Date();
    // แนบ server_time ให้ frontend คำนวณ offset เวลาได้ (เฉพาะ data ที่เป็น object)
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

// Function หา SSE client ของ session ที่ระบุ
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

// Function ตั้ง timer เตือนก่อน access token ของ SSE connection หมดอายุ
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

// Function เปิด SSE stream ให้ Admin รับ event แบบ realtime
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

  // ต้องดัก error ด้วย ไม่งั้น error ที่ไม่มี listener จะทำให้ process crash
  response.req.on("close", () => removeSseClient(clientId));
  response.req.on("error", () => removeSseClient(clientId));
  response.on("error", () => removeSseClient(clientId));
}

// Function ส่ง event ไปยัง SSE ของ session หนึ่งแล้วปิด connection (เช่นตอน session ถูก revoke)
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

// Function กระจาย event ไปยัง Admin SSE ทุก connection ที่ตรง audience
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

// Function สร้าง payload event สถานะ worker เปลี่ยน
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

// Function แจ้ง Admin ว่าสถานะ worker เปลี่ยน
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
