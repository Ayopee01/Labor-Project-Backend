// Import Library
import type { Session } from "better-sse";
import type { ServerResponse } from "http";
// Import Config
import { getDriverStreamConnectionLimit, getDriverTerminalSessionGraceMs } from "../config/driver.config";
import { VEHICLE_JOB_STATUS } from "../constants/status";
// Import Middlewares
import { toPascalCasePayload } from "../middlewares/api-case.middleware";
// Import Repositories
import * as driverRepository from "../repositories/driver.repository";
// Import Types
import type { DriverSessionContext } from "../types/driver.type";
// Import Utils
import { formatDriverJobSnapshot } from "../utils/driver-job.formatter";
import ApiError from "../utils/api-error";
import { getLogContext, runWithLogContext } from "../utils/log-context";
import { logger } from "../utils/logger";
import { openSseSession, pushSseEvent } from "../utils/sse";

/* -------------------------------------- Types -------------------------------------- */

// Type ชนิด event ที่ส่งให้ Driver ทาง SSE
type DriverStreamEventType =
  | "DRIVER_JOB_SNAPSHOT"
  | "DRIVER_JOB_UPDATED"
  | "DRIVER_JOB_TERMINAL"
  | "DRIVER_SESSION_EXPIRING"
  | "DRIVER_SESSION_CLOSED";

// Type ข้อมูล SSE client ของ Driver หนึ่ง connection
interface DriverStreamClient {
  id: number;
  sessionId: number;
  response: ServerResponse;
  // SSE session (ยังไม่มีระหว่างรอเปิด connection — จอง slot ไว้ก่อนให้นับ connection limit ถูก)
  stream?: Session;
  // timer ปิด connection ตอน session หมดอายุ (เฉพาะ session ที่ active ปกติ)
  expiryTimer?: NodeJS.Timeout;
}

/* -------------------------------------- Config -------------------------------------- */

// Config SSE client แยกตามงานรถ (เก็บในหน่วยความจำ เพราะ deploy แบบ single instance)
const clientsByTicketJob = new Map<number, Set<DriverStreamClient>>();
// Config TicketNumber ของงานรถที่มี stream เปิดอยู่ (ใช้อ้างอิงใน log/Sentry)
const ticketNumbersByTicketJob = new Map<number, string>();
let clientSequence = 1;

// Config หน่วงเวลารวม event ที่เกิดถี่ของงานรถเดียวกัน และ timer ที่รออยู่
const PUBLISH_DEBOUNCE_MS = 200;
const pendingPublishTimers = new Map<number, NodeJS.Timeout>();
const pendingEventTypes = new Map<number, DriverStreamEventType>();
const terminalCloseTimers = new Map<number, NodeJS.Timeout>();

/* -------------------------------------- Functions -------------------------------------- */

// Function สร้างข้อมูลอ้างอิงงานรถสำหรับ log ของ stream (เลขของ stream นี้เอง ไม่ใช่ของ request ที่เป็นตัว trigger)
function streamLogRef(ticketJobId: number): { ticketJobId: number; ticketNumber?: string } {
  return { ticketJobId, ticketNumber: ticketNumbersByTicketJob.get(ticketJobId) };
}

// Function เขียน SSE event ไปยัง driver client (ยังเปิด session ไม่เสร็จ = ข้าม เพราะจะได้ snapshot ตอนเชื่อมต่อเสร็จอยู่แล้ว)
function writeDriverEvent(
  client: DriverStreamClient,
  eventType: DriverStreamEventType,
  ticketJobId: number,
  job: unknown
): void {
  if (!client.stream) {
    return;
  }

  const now = new Date();
  const payload = toPascalCasePayload({
    event_id: `driver_job:${ticketJobId}:${now.getTime()}`,
    event_type: eventType,
    vehicle_job_id: ticketJobId,
    occurred_at: now.toISOString(),
    server_time: now.toISOString(),
    server_time_unix_ms: now.getTime(),
    job,
  });

  pushSseEvent(client.stream, eventType, payload);
}

// Function เอา client ออกจาก registry ตอน connection ปิด/หลุด
function removeDriverStreamClient(ticketJobId: number, client: DriverStreamClient): void {
  if (client.expiryTimer) {
    clearTimeout(client.expiryTimer);
  }

  const set = clientsByTicketJob.get(ticketJobId);
  set?.delete(client);

  if (set && set.size === 0) {
    clientsByTicketJob.delete(ticketJobId);
    ticketNumbersByTicketJob.delete(ticketJobId);
  }
}

// Function ปิด SSE connection ทั้งหมดของ session หนึ่ง (เช่นตอนเครื่องเดิมสแกน QR ซ้ำ)
export function closeDriverStreamSession(ticketJobId: number, sessionId: number): void {
  const set = clientsByTicketJob.get(ticketJobId);

  if (!set) {
    return;
  }

  for (const client of Array.from(set)) {
    if (client.sessionId !== sessionId) {
      continue;
    }

    writeDriverEvent(client, "DRIVER_SESSION_CLOSED", ticketJobId, null);
    removeDriverStreamClient(ticketJobId, client);

    try {
      client.response.end();
    } catch (error) {
      logger.error("Failed to close driver SSE connection after session revoke.", {
        ...streamLogRef(ticketJobId),
        sessionId,
        error,
      });
    }
  }
}

// Function ปิดทุก connection ของ vehicle job นี้พร้อม event ปิด session — ใช้ตอนหมด terminal grace period
function scheduleTerminalClose(ticketJobId: number): void {
  if (terminalCloseTimers.has(ticketJobId)) {
    return;
  }

  const timer = setTimeout(() => {
    terminalCloseTimers.delete(ticketJobId);

    const set = clientsByTicketJob.get(ticketJobId);

    if (!set) {
      return;
    }

    for (const client of Array.from(set)) {
      writeDriverEvent(client, "DRIVER_SESSION_CLOSED", ticketJobId, null);
      removeDriverStreamClient(ticketJobId, client);

      try {
        client.response.end();
      } catch (error) {
        logger.error("Failed to close driver SSE connection after terminal grace.", {
          ...streamLogRef(ticketJobId),
          error,
        });
      }
    }
  }, getDriverTerminalSessionGraceMs());

  terminalCloseTimers.set(ticketJobId, timer);
}

// Function โหลด snapshot ล่าสุดแล้ว broadcast ให้ทุก connection ของ vehicle job นี้
async function broadcastDriverJobSnapshot(
  ticketJobId: number,
  eventType: DriverStreamEventType
): Promise<void> {
  const set = clientsByTicketJob.get(ticketJobId);

  if (!set || set.size === 0) {
    return;
  }

  try {
    const record = await driverRepository.getDriverJobSnapshotRecord(ticketJobId);

    if (!record) {
      return;
    }

    const job = formatDriverJobSnapshot(record);

    for (const client of set) {
      writeDriverEvent(client, eventType, ticketJobId, job);
    }

    if (eventType === "DRIVER_JOB_TERMINAL") {
      scheduleTerminalClose(ticketJobId);
    }
  } catch (error) {
    logger.error("Failed to broadcast driver job snapshot.", { ...streamLogRef(ticketJobId), error });
  }
}

// Function แจ้ง Driver ว่างานรถเปลี่ยน (รวม event ถี่ๆ เป็นครั้งเดียว ต้องเรียกหลัง commit)
export function publishDriverJobUpdate(
  ticketJobId: number,
  eventType: Extract<DriverStreamEventType, "DRIVER_JOB_UPDATED" | "DRIVER_JOB_TERMINAL"> = "DRIVER_JOB_UPDATED"
): void {
  const set = clientsByTicketJob.get(ticketJobId);

  if (!set || set.size === 0) {
    return;
  }

  // Terminal event ต้องไม่ถูกลดระดับกลับเป็น UPDATED ถ้ามีสองเหตุการณ์ชนกันในหน้าต่าง debounce เดียวกัน
  if (pendingEventTypes.get(ticketJobId) !== "DRIVER_JOB_TERMINAL") {
    pendingEventTypes.set(ticketJobId, eventType);
  }

  if (pendingPublishTimers.has(ticketJobId)) {
    return;
  }

  const timer = setTimeout(() => {
    pendingPublishTimers.delete(ticketJobId);
    const finalEventType = pendingEventTypes.get(ticketJobId) ?? "DRIVER_JOB_UPDATED";
    pendingEventTypes.delete(ticketJobId);
    // context ใหม่ของงานรถนี้ (คง requestId ของต้นเหตุไว้ ไม่เอาเลขตั๋วของ request ต้นเหตุมาปน)
    void runWithLogContext({ requestId: getLogContext()?.requestId, ...streamLogRef(ticketJobId) }, () =>
      broadcastDriverJobSnapshot(ticketJobId, finalEventType)
    );
  }, PUBLISH_DEBOUNCE_MS);

  pendingPublishTimers.set(ticketJobId, timer);
}

// Function เปิด SSE stream ของงานรถให้ Driver และส่ง snapshot ทันทีทุกครั้งที่เชื่อมต่อ
export async function subscribeDriverJobStream(
  response: ServerResponse,
  session: DriverSessionContext
): Promise<void> {
  const ticketJobId = session.vehicle_job_id;
  const existingSet = clientsByTicketJob.get(ticketJobId) ?? new Set<DriverStreamClient>();
  const sessionConnectionCount = Array.from(existingSet).filter(
    (client) => client.sessionId === session.id
  ).length;

  if (sessionConnectionCount >= getDriverStreamConnectionLimit()) {
    throw new ApiError(
      409,
      "DRIVER_SOCKET_LIMIT_EXCEEDED",
      "Too many active connections for this driver session."
    );
  }

  const clientId = clientSequence;
  clientSequence += 1;

  const client: DriverStreamClient = {
    id: clientId,
    sessionId: session.id,
    response,
  };

  // จอง slot ก่อนเปิด session (มี await) กัน connection ที่เปิดพร้อมกันเกิน limit
  existingSet.add(client);
  clientsByTicketJob.set(ticketJobId, existingSet);
  ticketNumbersByTicketJob.set(ticketJobId, session.ticket_number);

  client.stream = await openSseSession(response, () => removeDriverStreamClient(ticketJobId, client));

  // หลุดไปก่อนเปิด session เสร็จ คืน slot แล้วไม่ต้องทำต่อ
  if (!client.stream.isConnected) {
    removeDriverStreamClient(ticketJobId, client);
    return;
  }

  if (session.is_read_only) {
    // session อยู่ใน grace period แล้ว เวลาปิดคุมโดย scheduleTerminalClose
    writeDriverEvent(client, "DRIVER_SESSION_EXPIRING", ticketJobId, null);
  } else {
    // session ปกติ ตั้ง timer ปิด connection ตอนหมดอายุ เพราะ SSE ไม่ตรวจ session ซ้ำ
    const msUntilExpiry = new Date(session.expires_at).getTime() - Date.now();

    if (msUntilExpiry > 0) {
      client.expiryTimer = setTimeout(() => {
        writeDriverEvent(client, "DRIVER_SESSION_CLOSED", ticketJobId, null);
        removeDriverStreamClient(ticketJobId, client);

        try {
          client.response.end();
        } catch (error) {
          logger.error("Failed to close driver SSE connection after session expiry.", {
            ...streamLogRef(ticketJobId),
            sessionId: session.id,
            error,
          });
        }
      }, msUntilExpiry);
    }
  }

  void (async () => {
    try {
      const record = await driverRepository.getDriverJobSnapshotRecord(ticketJobId);

      if (!record) {
        return;
      }

      writeDriverEvent(client, "DRIVER_JOB_SNAPSHOT", ticketJobId, formatDriverJobSnapshot(record));

      if (
        record.status === VEHICLE_JOB_STATUS.COMPLETED ||
        record.status === VEHICLE_JOB_STATUS.CANCELLED
      ) {
        // reconnect ระหว่าง grace period (scheduleTerminalClose ไม่ตั้ง timer ซ้ำ)
        scheduleTerminalClose(ticketJobId);
      }
    } catch (error) {
      logger.error("Failed to send initial driver job snapshot.", { ...streamLogRef(ticketJobId), error });
    }
  })();
}
