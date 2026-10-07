// Import Library
import type { IncomingMessage, Server } from "http";
import type { Duplex } from "stream";
import { WebSocket, WebSocketServer } from "ws";
// Import Config
import { getAccessTokenExpiresInSeconds, getAccessTokenRefreshThresholdSeconds } from "../config/auth.config";
import { readPositiveNumberEnv } from "../config/env";
// Import Middlewares
import { toPascalCasePayload } from "../middlewares/api-case.middleware";
// Import Repositories
import * as masterWorkerRepository from "../repositories/shared/master-worker.repository";
import { findActiveById as findActiveWorkerSessionById } from "../repositories/shared/worker-session.repository";
import { findCurrentAssignmentByWorker, getTicketJobTeamScanReadiness } from "../repositories/shared/ticket-job-assignment.repository";
// Import Services
import { publishNotification } from "../services/notifications.service";
import { buildWorkerNotification, persistWorkerNotification } from "../services/shared/realtime-notification.service";
import { sendWorkerPushNotificationByWorkerIds } from "../services/shared/worker-push.service";
// Import Queues
import { clearWorkerPresence, getWorkerQueueStatus, recordWorkerHeartbeat } from "../queues/worker-queue";
// Import Types
import { MASTER_WORKER_STATUS } from "../types/admin-workers.type";
import type { AccessTokenPayload } from "../types/auth.type";
import type { WorkerSocket, WorkerSocketEventOptions, WorkerSocketEventType, WorkerSocketPayload } from "../types/worker.type";
// Import Utils
import ApiError from "../utils/api-error";
import { verifyAccessToken } from "../utils/jwt";
import { logger } from "../utils/logger";
import { buildWorkerQueueSocketPayload } from "../utils/worker-payload";

/* -------------------------------------- Config -------------------------------------- */

// Config path ของ WebSocket ฝั่ง worker
const WORKER_SOCKET_PATH = "/ws/workers";

// Config เวลารอก่อนแจ้งว่า socket ของ worker หลุด (default 15 วินาที)
const WORKER_SOCKET_DISCONNECT_GRACE_MS = readPositiveNumberEnv("WORKER_SOCKET_DISCONNECT_GRACE_MS", 15000);

/* -------------------------------------- State -------------------------------------- */

// Config socket ของ worker ใน instance นี้ timer รอแจ้งหลุด และ server/heartbeat
const workerSockets = new Map<number, Set<WorkerSocket>>();
// Config WorkerCode ของ worker ที่เคยต่อ socket (ใช้อ้างอิงใน log/Sentry ไม่ต้อง query ซ้ำ)
const workerCodes = new Map<number, string>();
const disconnectTimers = new Map<number, NodeJS.Timeout>();
let workerWebSocketServer: WebSocketServer | null = null;
let heartbeatInterval: NodeJS.Timeout | null = null;

// Config handler พา worker กลับเข้าคิวหลังพัก (worker-dispatch ลงทะเบียนให้ กัน circular import)
let breakReturnRetryHandler: ((accountId: number) => Promise<void>) | null = null;

// Function ลงทะเบียน handler สำหรับ retry auto break-return ตอน worker ต่อ socket กลับมา
export function registerBreakReturnRetryHandler(
  handler: (accountId: number) => Promise<void>
): void {
  breakReturnRetryHandler = handler;
}

// Config event ของ Worker WebSocket ที่ต้องส่ง FCM push เพิ่มด้วย
const PUSH_WORKER_SOCKET_EVENTS = new Set<WorkerSocketEventType>([
  "WORKER_ASSIGNED",
  "ASSIGNMENT_TIMEOUT",
  "ASSIGNMENT_CANCELLED",
  "TEAM_READY",
  "ASSIGNMENT_SCAN_DEADLINE_EXTENDED",
  "ASSIGNMENT_SCAN_DEADLINE_SHORTENED",
  "ASSIGNMENT_SCAN_DEADLINE_WARNING",
  "TICKET_COMPLETION_SUBMITTED",
  "TICKET_COMPLETION_RESULT",
  "STALL_JOB_CANCELLED",
  "MARKET_JOB_CANCELLED",
  "VEHICLE_JOB_CANCELLED",
  "TICKET_JOB_UPDATED",
  "TICKET_WORKER_CANCELLED",
  "TICKET_WORKER_CANCELLED_FROM_BOOTH",
  "WORKER_BREAK_RETURN_ACTION_REQUIRED",
  "WORKER_BREAK_RETRY_EXPIRED",
  "WORKER_STATUS_FORCED_BY_ADMIN",
]);

/* -------------------------------------- Functions -------------------------------------- */

// Function ดึง socket token ใน Worker WebSocket (รับเฉพาะ header ไม่รับ ?token= เพราะ query string ติด log ของ proxy)
function getSocketToken(request: IncomingMessage): string {
  const authorization = request.headers.authorization;

  if (authorization) {
    const [scheme, token] = authorization.split(" ");

    if (scheme === "Bearer" && token) {
      return token;
    }
  }

  const protocol = request.headers["sec-websocket-protocol"];
  const protocolValue = Array.isArray(protocol) ? protocol[0] : protocol;
  const protocolToken = protocolValue
    ?.split(",")
    .map((value: string) => value.trim())
    .find((value: string) => value.startsWith("token."));

  if (protocolToken) {
    return protocolToken.replace("token.", "");
  }

  throw new ApiError(401, "INVALID_TOKEN", "Worker WebSocket token is required.");
}

// Function ยืนยันตัวตน worker socket ใน Worker WebSocket
async function authenticateWorkerSocket(
  request: IncomingMessage
): Promise<{ auth: AccessTokenPayload; workerCode: string }> {
  const payload = verifyAccessToken(getSocketToken(request));

  if (payload.role !== "worker") {
    throw new ApiError(403, "FORBIDDEN", "Worker account is required.");
  }

  const [worker, session] = await Promise.all([
    masterWorkerRepository.findById(payload.account_id),
    findActiveWorkerSessionById(payload.session_id),
  ]);

  if (!worker || worker.status !== MASTER_WORKER_STATUS.ACTIVE) {
    throw new ApiError(403, "WORKER_NOT_ACTIVE", "Worker account is not active.");
  }

  if (!session || session.account_id !== payload.account_id) {
    throw new ApiError(401, "SESSION_REVOKED", "Worker session is not active.");
  }

  return { auth: payload, workerCode: worker.labor_code };
}

// Function สร้างข้อมูลอ้างอิง worker สำหรับ log ของ socket
function socketLogRef(accountId: number): { workerId: number; workerCode?: string } {
  return { workerId: accountId, workerCode: workerCodes.get(accountId) };
}

// Function ตีกลับ socket upgrade ใน Worker WebSocket
function rejectSocketUpgrade(
  socket: Duplex,
  statusCode: number,
  message: string
): void {
  socket.write(
    [
      `HTTP/1.1 ${statusCode} ${message}`,
      "Connection: close",
      "Content-Type: text/plain",
      "",
      message,
    ].join("\r\n")
  );
  socket.destroy();
}

// Function ลงทะเบียน worker socket ใน Worker WebSocket
function registerWorkerSocket(accountId: number, sessionId: number, socket: WorkerSocket): void {
  const sockets = workerSockets.get(accountId) ?? new Set<WorkerSocket>();
  const disconnectTimer = disconnectTimers.get(accountId);

  if (disconnectTimer) {
    clearTimeout(disconnectTimer);
    disconnectTimers.delete(accountId);
  }

  socket.workerId = accountId;
  socket.sessionId = sessionId;
  socket.isAlive = true;
  sockets.add(socket);
  workerSockets.set(accountId, sockets);
}

// Function ตั้ง timer เตือนก่อน access token ของ socket หมดอายุ
function scheduleAccessTokenRefreshReminder(socket: WorkerSocket, exp: number | undefined): void {
  if (typeof exp !== "number") {
    return;
  }

  const thresholdSeconds = getAccessTokenRefreshThresholdSeconds();
  const accessTokenLifetimeMs = getAccessTokenExpiresInSeconds() * 1000;

  const fireReminder = (): void => {
    if (socket.readyState !== WebSocket.OPEN || !socket.workerId) {
      return;
    }

    sendWorkerSocketEvent(socket.workerId, "TOKEN_NEARING_EXPIRY", {}, { push: false });
    // เตือนซ้ำทุกรอบอายุ access token (ถือว่า client refresh ตามทุกครั้ง)
    socket.tokenRefreshTimer = setTimeout(fireReminder, accessTokenLifetimeMs);
  };

  const nowSeconds = Math.floor(Date.now() / 1000);
  const initialDelayMs = Math.max(0, (exp - nowSeconds - thresholdSeconds) * 1000);

  socket.tokenRefreshTimer = setTimeout(fireReminder, initialDelayMs);
}

// Function เคลียร์ timer เตือน access token ตอน socket ปิด กันยิงสัญญาณไปหา socket ที่ตายไปแล้ว
function clearAccessTokenRefreshReminder(socket: WorkerSocket): void {
  if (socket.tokenRefreshTimer) {
    clearTimeout(socket.tokenRefreshTimer);
    socket.tokenRefreshTimer = undefined;
  }
}

// Function ลบ socket ออกจาก registry และเริ่ม grace period ก่อนประกาศว่า disconnected
function handleWorkerSocketDisconnect(socket: WorkerSocket): void {
  const accountId = socket.workerId;

  if (!accountId) {
    return;
  }

  const sockets = workerSockets.get(accountId);
  sockets?.delete(socket);

  if (sockets && sockets.size > 0) {
    return;
  }

  workerSockets.delete(accountId);

  const timer = setTimeout(() => {
    void handleWorkerSocketGraceExpired(accountId).catch((error: unknown) => {
      logger.error("Failed to handle worker socket disconnect grace expiry.", { ...socketLogRef(accountId), error });
    });
  }, WORKER_SOCKET_DISCONNECT_GRACE_MS);

  disconnectTimers.set(accountId, timer);
}

// Function แจ้ง Admin ว่าการเชื่อมต่อของ worker เปลี่ยน
async function publishWorkerConnectionChanged(
  accountId: number,
  connected: boolean,
  reason: string,
): Promise<void> {
  const [assignment, queueEntry, worker] = await Promise.all([
    findCurrentAssignmentByWorker(accountId),
    getWorkerQueueStatus(accountId),
    masterWorkerRepository.findById(accountId).catch((error: unknown) => {
      logger.error("Failed to load worker profile for WebSocket connection event.", { ...socketLogRef(accountId), error });
      return null;
    }),
  ]);
  // ต้องใช้ความพร้อมของทีมด้วย ไม่งั้นสถานะจะเป็น WORKING ทั้งที่ทีมยังมาไม่ครบ
  const teamScanReadiness = assignment
    ? await getTicketJobTeamScanReadiness(assignment.vehicle_job_id)
    : null;

  const workerCode = worker?.labor_code ?? null;

  publishNotification({
    type: "WORKER_CONNECTION_CHANGED",
    title: connected ? "Worker socket connected" : "Worker socket disconnected",
    message: `Worker ${workerCode ?? accountId} socket ${connected ? "connected" : "disconnected"}.`,
    payload: {
      worker_code: workerCode,
      socket_connected: connected,
      queue: queueEntry
        ? buildWorkerQueueSocketPayload(queueEntry, workerCode, assignment, teamScanReadiness)
        : null,
      assignment_status: assignment?.status ?? null,
      reason,
    },
    audience: {
      roles: ["admin"],
    },
  });
}

// Function ปิด socket worker ที่หลุดเกิน grace โดยไม่เปลี่ยนสถานะคิวงาน
async function handleWorkerSocketGraceExpired(accountId: number): Promise<void> {
  disconnectTimers.delete(accountId);

  if (isWorkerSocketConnected(accountId)) {
    return;
  }

  logger.info("Worker socket disconnected.", { ...socketLogRef(accountId), graceMs: WORKER_SOCKET_DISCONNECT_GRACE_MS });
  await publishWorkerConnectionChanged(accountId, false, "socket_disconnected");
}

// Function ตัด socket ของ worker ทันทีเมื่อ session ถูก revoke (ไม่รอ grace period)
export async function disconnectWorkerSocket(
  accountId: number,
  reason: string,
): Promise<void> {
  const sockets = workerSockets.get(accountId);

  logger.info("Worker socket disconnected by server.", { ...socketLogRef(accountId), reason });

  if (sockets && sockets.size > 0) {
    for (const socket of sockets) {
      // ล้าง workerId ก่อนปิด กัน close handler แจ้งหลุดซ้ำ
      socket.workerId = undefined;
      socket.close();
    }
    workerSockets.delete(accountId);
  }

  const timer = disconnectTimers.get(accountId);

  if (timer) {
    clearTimeout(timer);
    disconnectTimers.delete(accountId);
  }

  await clearWorkerPresence(accountId);
  await publishWorkerConnectionChanged(accountId, false, reason);
}

// Function แปลภาษาข้อความตามภาษาของ worker บันทึก inbox/ส่ง push (ถ้าต้องส่ง) แล้วคืนข้อความสำหรับ socket
async function prepareWorkerSocketMessage(
  accountId: number,
  type: WorkerSocketEventType,
  payload: WorkerSocketPayload,
  options: WorkerSocketEventOptions
): Promise<string> {
  const shouldPush = options.push ?? PUSH_WORKER_SOCKET_EVENTS.has(type);
  const fallbackTitle = options.fallbackTitle ?? buildWorkerPushTitle(type);
  const fallbackMessage = options.fallbackMessage ?? buildWorkerPushMessage(type, payload);
  const worker = await masterWorkerRepository.findById(accountId);
  const localized = buildWorkerNotification({
    type,
    lang: worker?.lang,
    notification_key: options.notificationKey,
    notification_params: options.notificationParams,
    payload,
    fallbackTitle,
    fallbackMessage,
  });

  if (shouldPush) {
    persistWorkerNotification({
      worker_id: accountId,
      type,
      notification_key: localized.key,
      lang: localized.lang,
      title: localized.title,
      message: localized.message,
      payload,
    });

    void sendWorkerPushNotificationByWorkerIds({
      worker_ids: [accountId],
      type,
      title: fallbackTitle,
      message: fallbackMessage,
      notification_key: localized.key,
      notification_params: options.notificationParams,
      payload,
    }).catch((error: unknown) => {
      logger.error("Failed to send worker push notification.", { ...socketLogRef(accountId), type, error });
    });
  }

  const now = new Date();

  // แนบ server_time ให้ frontend คำนวณ offset เวลาได้เหมือน REST
  return JSON.stringify(
    toPascalCasePayload({
      type,
      notification: {
        key: localized.key,
        lang: localized.lang,
        title: localized.title,
        message: localized.message,
      },
      payload,
      occurred_at: now.toISOString(),
      server_time: now.toISOString(),
      server_time_unix_ms: now.getTime(),
    })
  );
}

// Function ส่งข้อความให้ทุก socket ที่ยังเปิดอยู่
function sendToSockets(sockets: Iterable<WorkerSocket>, message: string): void {
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(message);
    }
  }
}

// Function ส่ง worker socket event ใน Worker WebSocket
export function sendWorkerSocketEvent(
  accountId: number,
  type: WorkerSocketEventType,
  payload: WorkerSocketPayload = {},
  options: WorkerSocketEventOptions = {}
): boolean {
  const hasSockets = Boolean(workerSockets.get(accountId)?.size);

  void prepareWorkerSocketMessage(accountId, type, payload, options)
    .then((message) => {
      // อ่าน socket ล่าสุดตอนส่ง (อาจต่อเข้ามาหรือหลุดระหว่างแปลภาษา)
      sendToSockets(workerSockets.get(accountId) ?? [], message);
    })
    .catch((error: unknown) => {
      logger.error("Failed to send worker socket event.", { ...socketLogRef(accountId), type, error });
    });

  return hasSockets;
}

// Function ส่ง event ให้เฉพาะ socket ของ session ที่ถูก revoke แล้วปิด socket เหล่านั้น (เครื่องอื่นไม่ถูกแตะ)
export async function revokeWorkerSocketSession(
  accountId: number,
  sessionId: number,
  reason: string,
  event?: { type: WorkerSocketEventType; payload: WorkerSocketPayload; options?: WorkerSocketEventOptions }
): Promise<void> {
  const sockets = workerSockets.get(accountId);
  const sessionSockets = [...(sockets ?? [])].filter((socket) => socket.sessionId === sessionId);

  if (!sockets || sessionSockets.length === 0) {
    return;
  }

  // ส่งข้อความให้เสร็จก่อนปิด ไม่งั้น socket อาจปิดก่อนข้อความออกไป
  if (event) {
    const message = await prepareWorkerSocketMessage(accountId, event.type, event.payload, event.options ?? {});

    sendToSockets(sessionSockets, message);
  }

  for (const socket of sessionSockets) {
    // ล้าง workerId ก่อนปิด กัน close handler แจ้งหลุดซ้ำ
    socket.workerId = undefined;
    sockets.delete(socket);
    socket.close();
  }

  // ยังมีเครื่องอื่นต่ออยู่ = worker ยัง online ไม่ต้องล้าง presence
  if (sockets.size > 0) {
    return;
  }

  workerSockets.delete(accountId);
  await clearWorkerPresence(accountId);
  await publishWorkerConnectionChanged(accountId, false, reason);
}

// Function สร้าง title ของ FCM notification ให้ตรงกับชนิด event จาก Worker WebSocket
function buildWorkerPushTitle(type: WorkerSocketEventType): string {
  switch (type) {
    case "WORKER_ASSIGNED":
      return "New assignment";
    case "ASSIGNMENT_TIMEOUT":
      return "Assignment timed out";
    case "ASSIGNMENT_CANCELLED":
    case "STALL_JOB_CANCELLED":
    case "MARKET_JOB_CANCELLED":
    case "VEHICLE_JOB_CANCELLED":
      return "Assignment cancelled";
    case "TICKET_JOB_UPDATED":
      return "Ticket updated";
    case "TICKET_WORKER_CANCELLED":
      return "Removed from business ticket";
    case "TICKET_WORKER_CANCELLED_FROM_BOOTH":
      return "Removed from booth";
    case "TEAM_READY":
      return "Team ready";
    case "ASSIGNMENT_SCAN_DEADLINE_EXTENDED":
      return "Scan deadline extended";
    case "ASSIGNMENT_SCAN_DEADLINE_SHORTENED":
      return "Scan deadline updated";
    case "ASSIGNMENT_SCAN_DEADLINE_WARNING":
      return "Scan deadline reminder";
    case "TICKET_COMPLETION_SUBMITTED":
      return "Ticket submitted";
    case "TICKET_COMPLETION_RESULT":
      return "Ticket result updated";
    case "SESSION_REVOKED":
      return "Signed in on another device";
    case "WORKER_BREAK_RETURN_ACTION_REQUIRED":
      return "Open the app to return to the queue";
    case "WORKER_BREAK_RETRY_EXPIRED":
      return "Please contact Admin";
    case "WORKER_STATUS_FORCED_BY_ADMIN":
      return "Your status was changed by admin";
    default:
      return "Worker notification";
  }
}

// Function สร้าง body ของ FCM notification โดยเก็บรายละเอียดไว้ใน payload
function buildWorkerPushMessage(
  type: WorkerSocketEventType,
  payload: WorkerSocketPayload
): string {
  const ticketNumber = typeof payload.ticketNumber === "string" ? payload.ticketNumber : null;

  switch (type) {
    case "WORKER_ASSIGNED":
      return ticketNumber
        ? `You have a new assignment for ticket ${ticketNumber}.`
        : "You have a new assignment.";
    case "ASSIGNMENT_TIMEOUT":
      return "Your assignment deadline has expired.";
    case "ASSIGNMENT_CANCELLED":
    case "STALL_JOB_CANCELLED":
    case "MARKET_JOB_CANCELLED":
    case "VEHICLE_JOB_CANCELLED":
      return ticketNumber
        ? `Assignment ${ticketNumber} was cancelled.`
        : "Your assignment was cancelled.";
    case "TICKET_JOB_UPDATED":
      return typeof payload.ticketNo === "string"
        ? `Ticket ${payload.ticketNo} was updated by Gate.`
        : "Your ticket was updated by Gate.";
    case "TICKET_WORKER_CANCELLED":
      return "Admin removed you from a business ticket.";
    case "TICKET_WORKER_CANCELLED_FROM_BOOTH":
      return "Admin removed you from a booth.";
    case "TEAM_READY":
      return "Your whole team has checked in. You can start working now.";
    case "ASSIGNMENT_SCAN_DEADLINE_EXTENDED":
      return "Your QR scan deadline was extended.";
    case "ASSIGNMENT_SCAN_DEADLINE_SHORTENED":
      return "Please scan QR before the updated deadline.";
    case "ASSIGNMENT_SCAN_DEADLINE_WARNING": {
      const remainingMinutes =
        typeof payload.remaining_minutes === "number" ? payload.remaining_minutes : null;

      return remainingMinutes != null
        ? `You have ${remainingMinutes} minutes left to scan the QR code.`
        : "Your QR scan deadline is approaching.";
    }
    case "TICKET_COMPLETION_SUBMITTED":
      return "Ticket completion is waiting for vendor confirmation.";
    case "TICKET_COMPLETION_RESULT":
      return "Vendor confirmation result is available.";
    case "SESSION_REVOKED":
      return "This session was signed out because login was confirmed on another device.";
    case "WORKER_BREAK_RETURN_ACTION_REQUIRED":
      return "Your break has ended. Open the app and go online to return to the queue.";
    case "WORKER_BREAK_RETRY_EXPIRED":
      return "You did not return from break in time. Please contact Admin to return to the queue.";
    case "WORKER_STATUS_FORCED_BY_ADMIN": {
      const status = typeof payload.status === "string" ? payload.status : null;

      return status
        ? `Your status was changed to ${status} by admin.`
        : "Your status was changed by admin.";
    }
    default:
      return "A worker notification is available.";
  }
}

// Function ตรวจว่า worker socket connected ใน Worker WebSocket
export function isWorkerSocketConnected(accountId: number): boolean {
  const sockets = workerSockets.get(accountId);

  if (!sockets) {
    return false;
  }

  return Array.from(sockets).some((socket) => socket.readyState === WebSocket.OPEN);
}

// Function อัปเดต presence หลัง Worker socket เชื่อมต่อสำเร็จ
async function handleWorkerSocketConnected(accountId: number): Promise<void> {
  await recordWorkerHeartbeat(accountId);

  const worker = await masterWorkerRepository.findById(accountId).catch((error: unknown) => {
    logger.error("Failed to load worker profile for WebSocket connection.", { ...socketLogRef(accountId), error });
    return null;
  });
  const workerCode = worker?.labor_code ?? null;

  sendWorkerSocketEvent(accountId, "WORKER_CONNECTED", {
    worker_code: workerCode,
  });

  await publishWorkerConnectionChanged(accountId, true, "socket_connected");

  if (breakReturnRetryHandler) {
    await breakReturnRetryHandler(accountId).catch((error: unknown) => {
      logger.error("Failed to retry worker break return after reconnect.", { ...socketLogRef(accountId), error });
    });
  }
}

// Function ตั้งค่า worker web socket ใน Worker WebSocket
export function setupWorkerWebSocket(server: Server): void {
  // server ไม่รับข้อความจาก client จึงจำกัดขนาดไว้ต่ำ กัน client ส่งข้อมูลใหญ่จนหน่วยความจำบวม
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: 4096,
  });
  workerWebSocketServer = webSocketServer;

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "", "http://localhost");

    if (url.pathname !== WORKER_SOCKET_PATH) {
      rejectSocketUpgrade(socket, 404, "WebSocket Not Found");
      return;
    }

    authenticateWorkerSocket(request)
      .then(({ auth, workerCode }) => {
        workerCodes.set(auth.account_id, workerCode);
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          webSocketServer.emit("connection", webSocket, request, auth);
        });
      })
      .catch((error) => {
        const statusCode = error instanceof ApiError ? error.statusCode : 401;

        // upgrade ไม่ผ่าน request logger จึงต้อง log เอง (เช่น token หมดอายุ, session ถูก revoke)
        logger.warn("Worker socket upgrade rejected.", {
          statusCode,
          errorCode: error instanceof ApiError ? error.code : "INVALID_TOKEN",
          ip: request.socket.remoteAddress,
          clientVersion: request.headers["x-client-version"],
        });
        rejectSocketUpgrade(socket, statusCode, "WebSocket Unauthorized");
      });
  });

  webSocketServer.on(
    "connection",
    (socket: WorkerSocket, _request: IncomingMessage, auth: AccessTokenPayload) => {
      registerWorkerSocket(auth.account_id, auth.session_id, socket);
      logger.info("Worker socket connected.", { ...socketLogRef(auth.account_id), sessionId: auth.session_id });
      scheduleAccessTokenRefreshReminder(socket, auth.exp);
      // ต้อง catch ทุก fire-and-forget ที่แตะ Redis/DB — rejection ที่ไม่มีใครรับจะทำให้ Node ปิด process ทั้งตัว
      void handleWorkerSocketConnected(auth.account_id).catch((error: unknown) => {
        logger.error("Failed to handle worker socket connection.", {
          ...socketLogRef(auth.account_id),
          error,
        });
      });

      socket.on("pong", () => {
        socket.isAlive = true;
        if (socket.workerId) {
          const workerId = socket.workerId;

          void recordWorkerHeartbeat(workerId).catch((error: unknown) => {
            logger.error("Failed to record worker heartbeat.", { ...socketLogRef(workerId), error });
          });
        }
      });

      socket.on("close", () => {
        clearAccessTokenRefreshReminder(socket);
        handleWorkerSocketDisconnect(socket);
      });
    }
  );

  heartbeatInterval = setInterval(() => {
    webSocketServer.clients.forEach((socket) => {
      const workerSocket = socket as WorkerSocket;

      if (workerSocket.isAlive === false) {
        workerSocket.terminate();
        return;
      }

      workerSocket.isAlive = false;
      workerSocket.ping();
    });
  }, 30000);
}

// Function ปิด Worker WebSocket server และเคลียร์ timer ทั้งหมดสำหรับ graceful shutdown
export function closeWorkerWebSocketServer(): Promise<void> {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }

  for (const timer of disconnectTimers.values()) {
    clearTimeout(timer);
  }
  disconnectTimers.clear();

  const server = workerWebSocketServer;
  workerWebSocketServer = null;

  if (!server) {
    return Promise.resolve();
  }

  server.clients.forEach((socket) => socket.close());

  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
