// Import Library
import type { NextFunction, Request, Response } from "express";
// Import Utils
import { setLogContext } from "../utils/log-context";

/* -------------------------------------- Config -------------------------------------- */

// Config รูปแบบเลข TicketNumber/TicketNo (ตัวเลข 14 หลัก) ค่าอื่นไม่ใส่ log
const TICKET_REFERENCE_PATTERN = /^\d{14}$/;

/* -------------------------------------- Functions -------------------------------------- */

// Function สร้าง router.param handler ที่เติม TicketNumber/TicketNo จาก path ลง log context
export function ticketReferenceLogParam(field: "ticketNumber" | "ticketNo") {
  return (_req: Request, _res: Response, next: NextFunction, value: unknown): void => {
    if (typeof value === "string" && TICKET_REFERENCE_PATTERN.test(value)) {
      setLogContext({ [field]: value });
    }

    next();
  };
}
