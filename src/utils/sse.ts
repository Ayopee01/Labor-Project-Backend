// Import Library
import { createSession, EventBuffer, type Session } from "better-sse";
import type { ServerResponse } from "http";
// Import Utils
import { logger } from "./logger";

/* -------------------------------------- Config -------------------------------------- */

// Config option ของ SSE session (ส่ง keep-alive comment ทุก 25 วินาที กัน proxy ตัด connection ที่เงียบ, ไม่ส่ง retry field)
const SSE_SESSION_OPTIONS = {
  keepAlive: 25_000,
  retry: null,
} as const;

/* -------------------------------------- Functions -------------------------------------- */

// Function เปิด SSE session บน response (resolve เมื่อส่ง header แล้ว พร้อม push event)
export async function openSseSession(response: ServerResponse, onClose: () => void): Promise<Session> {
  // ต้องดัก error ด้วย ไม่งั้น error ที่ไม่มี listener จะทำให้ process crash
  response.req.on("error", onClose);
  response.on("error", onClose);

  const session = await createSession(response.req, response, SSE_SESSION_OPTIONS);

  session.once("disconnected", onClose);
  return session;
}

// Function ส่ง SSE event (ไม่มี eventId = ไม่ส่ง id: เพื่อไม่ทับ Last-Event-ID ของ browser) catch error เผื่อ connection หลุดไปแล้ว
export function pushSseEvent(session: Session, eventName: string, data: unknown, eventId?: string): void {
  if (!session.isConnected) {
    return;
  }

  try {
    if (eventId) {
      session.push(data, eventName, eventId);
      return;
    }

    // ส่ง EventBuffer ตรงๆ ให้ batch เขียนทันทีใน tick เดียวกัน (ลำดับ event ไม่สลับกับ push)
    void session.batch(new EventBuffer().event(eventName).data(data).dispatch());
  } catch (error) {
    logger.warn("Failed to write SSE event.", { eventName, error });
  }
}
