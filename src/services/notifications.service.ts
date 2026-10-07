// Import Library
import type { Response } from "express";
// Import Config
import { getAccessTokenExpiresInSeconds, getAccessTokenRefreshThresholdSeconds } from "../config/auth.config";
// Import Middlewares
import { toPascalCasePayload } from "../middlewares/api-case.middleware";
// Import Types
import type { AccessTokenPayload } from "../types/auth.type";
import type { BufferedNotificationEvent, NotificationAudience, NotificationClient, NotificationReplayResult, RealtimeNotificationEvent, WorkerStatusChangedInput } from "../types/notifications.type";
import type { TicketJobAssignmentDto, VehicleWorkReadinessDto, WorkerQueueEntryDto } from "../types/worker.type";
// Import Utils
import { buildWorkerQueueSocketPayload } from "../utils/worker-payload";
import { logger } from "../utils/logger";

/* -------------------------------------- Config -------------------------------------- */

// Config SSE client ที่เชื่อมต่ออยู่และตัวนับ id
const clients = new Map<number, NotificationClient>();
let clientSequence = 1;

// Config ค่า default ของ replay buffer (in-memory เพราะ production รัน instance เดียว)
const ADMIN_SSE_REPLAY_DEFAULTS = {
  maxEvents: 1000,
  maxAgeSeconds: 10 * 60,
} as const;

// Config event ID = <epoch ของ process>-<ลำดับ> ทำให้ ID จากก่อน restart ถูกตรวจเป็น stale ได้
const streamEpoch = Date.now().toString(36);
let eventSequence = 0;
const replayBuffer: BufferedNotificationEvent[] = [];

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

// Function อ่านค่าจำนวนเต็มบวกจาก env (ไม่ถูกต้องใช้ fallback)
function readPositiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);

  return Number.isInteger(value) && value > 0 ? value : fallback;
}

// Function ตัด event ที่เกินจำนวนหรือเก่าเกินอายุออกจากหัว replay buffer
function pruneReplayBuffer(nowMs: number): void {
  const maxEvents = readPositiveIntegerEnv("ADMIN_SSE_REPLAY_MAX_EVENTS", ADMIN_SSE_REPLAY_DEFAULTS.maxEvents);
  const maxAgeMs =
    readPositiveIntegerEnv("ADMIN_SSE_REPLAY_MAX_AGE_SECONDS", ADMIN_SSE_REPLAY_DEFAULTS.maxAgeSeconds) * 1000;

  while (
    replayBuffer.length > maxEvents ||
    (replayBuffer.length > 0 && nowMs - replayBuffer[0].buffered_at_ms > maxAgeMs)
  ) {
    replayBuffer.shift();
  }
}

// Function เก็บ event ธุรกิจลง replay buffer พร้อมออก ID ใหม่
function appendReplayEvent(
  type: string,
  payload: Record<string, unknown>,
  audience?: NotificationAudience
): BufferedNotificationEvent {
  const nowMs = Date.now();

  eventSequence += 1;

  const bufferedEvent: BufferedNotificationEvent = {
    id: `${streamEpoch}-${eventSequence}`,
    sequence: eventSequence,
    type,
    payload,
    audience,
    buffered_at_ms: nowMs,
  };

  replayBuffer.push(bufferedEvent);
  pruneReplayBuffer(nowMs);

  return bufferedEvent;
}

// Function หา event หลัง Last-Event-ID (ID ผิดรูปแบบ ต่าง epoch หรือหลุด buffer ต้อง resync)
function resolveReplayEvents(lastEventId: string): NotificationReplayResult {
  pruneReplayBuffer(Date.now());

  const separatorIndex = lastEventId.lastIndexOf("-");
  const epoch = lastEventId.slice(0, separatorIndex);
  const sequence = Number(lastEventId.slice(separatorIndex + 1));

  if (separatorIndex <= 0 || epoch !== streamEpoch || !Number.isInteger(sequence) || sequence < 0) {
    return { status: "resync" };
  }

  if (sequence > eventSequence) {
    return { status: "resync" };
  }

  if (sequence === eventSequence) {
    return { status: "replay", events: [] };
  }

  // buffer ต่อเนื่องเสมอ (ตัดจากหัวเท่านั้น) ถ้า event ถัดจาก ID นี้หลุดไปแล้วแปลว่ามีช่องว่าง
  const oldestSequence = replayBuffer[0]?.sequence;

  if (oldestSequence === undefined || sequence + 1 < oldestSequence) {
    return { status: "resync" };
  }

  return {
    status: "replay",
    events: replayBuffer.filter((bufferedEvent) => bufferedEvent.sequence > sequence),
  };
}

// Function เขียน SSE event ไปยัง client (catch error เผื่อ connection หลุดไปแล้ว)
function writeSseEvent(
  response: Response,
  eventName: string,
  data: unknown,
  eventId?: string
): void {
  try {
    const now = new Date();
    // แนบ server_time ให้ frontend คำนวณ offset เวลาได้ (เฉพาะ data ที่เป็น object)
    const eventData =
      data && typeof data === "object" && !Array.isArray(data)
        ? { ...data, server_time: now.toISOString(), server_time_unix_ms: now.getTime() }
        : data;

    if (eventId) {
      response.write(`id: ${eventId}\n`);
    }

    response.write(`event: ${eventName}\n`);
    response.write(`data: ${JSON.stringify(toPascalCasePayload(eventData))}\n\n`);
  } catch (error) {
    logger.error("Failed to write SSE event.", { error });
  }
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

// Function ส่ง event ที่พลาดไประหว่างหลุดให้ client ก่อน live event (กรอง audience ด้วย token ปัจจุบัน)
function replayMissedEvents(
  response: Response,
  auth: AccessTokenPayload,
  lastEventId: string
): void {
  const replay = resolveReplayEvents(lastEventId);

  if (replay.status === "resync") {
    writeSseEvent(response, "STREAM_RESYNC_REQUIRED", {
      reason: "LAST_EVENT_ID_NOT_AVAILABLE",
      last_event_id: lastEventId,
    });
    return;
  }

  for (const bufferedEvent of replay.events) {
    if (canReceiveEvent(auth, bufferedEvent.audience)) {
      writeSseEvent(response, bufferedEvent.type, bufferedEvent.payload, bufferedEvent.id);
    }
  }
}

// Function เปิด SSE stream ให้ Admin รับ event แบบ realtime (มี Last-Event-ID จะ replay ก่อน)
export function subscribeAdminEvents(
  response: Response,
  auth: AccessTokenPayload,
  lastEventId?: string
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

  // replay และ register client ต้องอยู่ใน tick เดียวกัน (ห้าม await คั่น) เพื่อไม่ให้ event หลุดหรือซ้ำ
  if (lastEventId) {
    replayMissedEvents(response, auth, lastEventId);
  }

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

// Function ส่ง event แล้วปิด SSE ทุก connection ที่ตรงเงื่อนไข (เปิดหลายแท็บก็ปิดครบ) คืนจำนวนที่ปิด
function closeSseClients(
  matches: (client: NotificationClient) => boolean,
  eventName: string,
  data: unknown
): number {
  const matchedClients = [...clients.values()].filter(matches);

  for (const client of matchedClients) {
    writeSseEvent(client.response, eventName, data);
    removeSseClient(client.id);
    client.response.end();
  }

  return matchedClients.length;
}

// Function ส่ง event ไปยัง SSE ของ session หนึ่งแล้วปิด connection (เช่นตอน session ถูก revoke)
export function sendAdminSseEventToSession(
  sessionId: number,
  eventName: string,
  data: unknown
): boolean {
  return closeSseClients((client) => client.auth.session_id === sessionId, eventName, data) > 0;
}

// Function ปิด SSE ทุก session ของ Admin คนหนึ่งหลัง session ถูก revoke (เว้น session ที่ยังใช้ต่อได้)
export function closeAdminSseByAccount(
  accountId: number,
  data: unknown,
  exceptSessionId?: number
): number {
  return closeSseClients(
    (client) => client.auth.account_id === accountId && client.auth.session_id !== exceptSessionId,
    "SESSION_REVOKED",
    data
  );
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
  const bufferedEvent = appendReplayEvent(event.type, payload, event.audience);

  for (const client of clients.values()) {
    if (!canReceiveEvent(client.auth, event.audience)) {
      continue;
    }

    writeSseEvent(client.response, event.type, payload, bufferedEvent.id);
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
