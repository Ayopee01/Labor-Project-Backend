// Import Library
import type { Response } from "express";
// Import Config
import { getDriverStreamConnectionLimit, getDriverTerminalSessionGraceMs } from "../config/driver.config";
import { VEHICLE_JOB_STATUS } from "../constants/status";
// Import Middleware
import { toPascalCasePayload } from "../middlewares/api-case.middleware";
// Import Repositories
import * as driverRepository from "../repositories/driver.repository";
// Import Utils
import { formatDriverJobSnapshot } from "../utils/driver-job.formatter";
import ApiError from "../utils/api-error";
import { logger } from "../utils/logger";
// Import Types
import type { DriverSessionContext } from "../types/driver.type";

/* -------------------------------------- Types -------------------------------------- */

type DriverStreamEventType =
  | "DRIVER_JOB_SNAPSHOT"
  | "DRIVER_JOB_UPDATED"
  | "DRIVER_JOB_TERMINAL"
  | "DRIVER_SESSION_EXPIRING"
  | "DRIVER_SESSION_CLOSED";

interface DriverStreamClient {
  id: number;
  sessionId: number;
  response: Response;
  heartbeat: NodeJS.Timeout;
}

/* -------------------------------------- Config -------------------------------------- */

// State เก็บ SSE client ของ instance ปัจจุบัน แยกตาม vehicle_job_id — โปรเจกต์นี้ deploy เป็น single
// instance เท่านั้น (ไม่มี load balancer/cluster) จึง registry แบบ in-memory ตัวเดียวพอ ไม่ต้องทำ
// Redis Pub/Sub ข้าม instance (ต่างจากที่ spec ต้นฉบับเผื่อไว้สำหรับ multi-instance)
const clientsByTicketJob = new Map<number, Set<DriverStreamClient>>();
let clientSequence = 1;

// Config หน่วงเวลา coalesce event ถี่ต่อ vehicle_job_id เดียวกัน (ตามสเปค 38.7: 100-250ms)
const PUBLISH_DEBOUNCE_MS = 200;
const pendingPublishTimers = new Map<number, NodeJS.Timeout>();
const pendingEventTypes = new Map<number, DriverStreamEventType>();
const terminalCloseTimers = new Map<number, NodeJS.Timeout>();

/* -------------------------------------- Functions -------------------------------------- */

// Function เขียน SSE event ไปยัง driver client — ครอบด้วย try/catch เพราะ response อาจถูก destroy ไปแล้ว
function writeDriverEvent(
  response: Response,
  eventType: DriverStreamEventType,
  ticketJobId: number,
  job: unknown
): void {
  try {
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

    response.write(`event: ${eventType}\n`);
    response.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch (error) {
    logger.error("Failed to write driver SSE event.", { ticketJobId, error });
  }
}

// Function เอา client ออกจาก registry ตอน connection ปิด/หลุด
function removeDriverStreamClient(ticketJobId: number, client: DriverStreamClient): void {
  clearInterval(client.heartbeat);

  const set = clientsByTicketJob.get(ticketJobId);
  set?.delete(client);

  if (set && set.size === 0) {
    clientsByTicketJob.delete(ticketJobId);
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
      writeDriverEvent(client.response, "DRIVER_SESSION_CLOSED", ticketJobId, null);
      removeDriverStreamClient(ticketJobId, client);

      try {
        client.response.end();
      } catch (error) {
        logger.error("Failed to close driver SSE connection after terminal grace.", {
          ticketJobId,
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
      writeDriverEvent(client.response, eventType, ticketJobId, job);
    }

    if (eventType === "DRIVER_JOB_TERMINAL") {
      scheduleTerminalClose(ticketJobId);
    }
  } catch (error) {
    logger.error("Failed to broadcast driver job snapshot.", { ticketJobId, error });
  }
}

// Function ประกาศว่า vehicle job นี้มีการเปลี่ยนแปลงที่ Driver ต้องเห็น — coalesce ภายใน
// PUBLISH_DEBOUNCE_MS ต่อ vehicle_job_id กันยิง query/event ซ้ำถ้ามีหลายเหตุการณ์เกิดถี่ๆ ต้องเรียก
// หลัง transaction commit สำเร็จเท่านั้น ห้ามเรียกจากข้อมูลที่อาจ rollback
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
    void broadcastDriverJobSnapshot(ticketJobId, finalEventType);
  }, PUBLISH_DEBOUNCE_MS);

  pendingPublishTimers.set(ticketJobId, timer);
}

// Function subscribe Driver ให้เข้า SSE stream ของ vehicle job ตน — ส่ง DRIVER_JOB_SNAPSHOT ทันทีหลัง
// subscribe สำเร็จทุกครั้ง (รวม reconnect) ตามสเปค เพื่อไม่ต้อง polling ชดเชย event ที่พลาด
export function subscribeDriverJobStream(
  response: Response,
  session: DriverSessionContext
): void {
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

  response.setHeader("Content-Type", "text/event-stream");
  response.setHeader("Cache-Control", "no-cache, no-transform");
  response.setHeader("Connection", "keep-alive");
  response.flushHeaders?.();

  const clientId = clientSequence;
  clientSequence += 1;

  const heartbeat = setInterval(() => {
    try {
      response.write(`: heartbeat ${new Date().toISOString()}\n\n`);
    } catch (error) {
      logger.error("Failed to write driver SSE heartbeat.", { ticketJobId, error });
    }
  }, 25000);

  const client: DriverStreamClient = {
    id: clientId,
    sessionId: session.id,
    response,
    heartbeat,
  };

  existingSet.add(client);
  clientsByTicketJob.set(ticketJobId, existingSet);

  if (session.is_read_only) {
    writeDriverEvent(response, "DRIVER_SESSION_EXPIRING", ticketJobId, null);
  }

  void (async () => {
    try {
      const record = await driverRepository.getDriverJobSnapshotRecord(ticketJobId);

      if (!record) {
        return;
      }

      writeDriverEvent(response, "DRIVER_JOB_SNAPSHOT", ticketJobId, formatDriverJobSnapshot(record));

      if (
        record.status === VEHICLE_JOB_STATUS.COMPLETED ||
        record.status === VEHICLE_JOB_STATUS.CANCELLED
      ) {
        // Reconnect ระหว่าง grace period เดิม — scheduleTerminalClose กัน reset ซ้ำเองอยู่แล้ว (guard ด้วย terminalCloseTimers.has)
        scheduleTerminalClose(ticketJobId);
      }
    } catch (error) {
      logger.error("Failed to send initial driver job snapshot.", { ticketJobId, error });
    }
  })();

  response.req.on("close", () => removeDriverStreamClient(ticketJobId, client));
  response.req.on("error", () => removeDriverStreamClient(ticketJobId, client));
  response.on("error", () => removeDriverStreamClient(ticketJobId, client));
}
