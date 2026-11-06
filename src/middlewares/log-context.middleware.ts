// Import Types
import type { AppMiddleware } from "../types/shared/http.type";
// Import Utils
import { setLogContext } from "../utils/log-context";

/* -------------------------------------- Config -------------------------------------- */

// Config รูปแบบเลข TicketNumber/TicketNo (ตัวเลข 14 หลัก) ค่าอื่นไม่ใส่ log
const TICKET_REFERENCE_PATTERN = /^\d{14}$/;

/* -------------------------------------- Functions -------------------------------------- */

// Function สร้าง middleware ที่เติม TicketNumber/TicketNo จาก path ลง log context
export function ticketReferenceLogParam(field: "ticketNumber" | "ticketNo"): AppMiddleware {
  return async (c, next) => {
    const value = c.req.param(field);

    if (typeof value === "string" && TICKET_REFERENCE_PATTERN.test(value)) {
      setLogContext({ [field]: value });
    }

    await next();
  };
}
