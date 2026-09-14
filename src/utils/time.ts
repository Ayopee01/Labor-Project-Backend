import type { WorkerStatusResponse } from "../types/worker.type";

export const BANGKOK_TIME_ZONE = "Asia/Bangkok";
const DAY_MS = 24 * 60 * 60 * 1000;

/* -------------------------------------- Functions -------------------------------------- */

// Function สร้าง deadline สำหรับ helper กลาง
export function buildDeadline(durationMs: number, baseTime = Date.now()): Date {
  return new Date(baseTime + durationMs);
}

// Function ดึง delay until สำหรับ helper กลาง
export function getDelayUntil(deadlineAt: string | null, baseTime = Date.now()): number {
  if (!deadlineAt) {
    return 0;
  }

  const deadlineMs = new Date(deadlineAt).getTime();

  if (!Number.isFinite(deadlineMs)) {
    return 0;
  }

  return Math.max(0, deadlineMs - baseTime);
}

export function toUnixMs(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }

  const timeMs = new Date(value).getTime();

  return Number.isFinite(timeMs) ? timeMs : null;
}

// Function สร้าง bangkok date range สำหรับ helper กลาง
export function buildBangkokDateRange(date: string): { startAt: Date; endAt: Date } {
  const startAt = new Date(`${date}T00:00:00.000+07:00`);
  const endAt = new Date(startAt.getTime() + DAY_MS);

  return {
    startAt,
    endAt,
  };
}

export function buildLatestCompletedBangkokDateRange(
  dayCount: number,
  baseDate: Date = new Date()
): { startAt: Date; endAt: Date; dates: string[] } {
  const today = formatBangkokDate(baseDate);
  const endAt = new Date(`${today}T00:00:00.000+07:00`);
  const startAt = new Date(endAt.getTime() - dayCount * DAY_MS);
  const dates = Array.from({ length: dayCount }, (_, index) => {
    const date = new Date(startAt.getTime() + index * DAY_MS);

    return formatBangkokDate(date);
  });

  return {
    startAt,
    endAt,
    dates,
  };
}

// Function สร้าง bangkok date span range สำหรับ helper กลาง
// timeFrom/timeTo เป็น "HH:mm" optional — ไม่ส่งมาพฤติกรรมเดิมทุกประการ (ทั้งวันของ dateFrom/dateTo)
// ส่งมา startAt จะขยับไปที่เวลานั้นตรงๆ (gte รวมเวลานั้นพอดี) ส่วน endAt จะปัดขึ้นไปสิ้นนาทีนั้น (+1
// นาทีแล้วใช้ lt) เพื่อให้ "ถึงเวลา X" รวมนาที X ทั้งนาที ไม่ตัดทิ้งตอน 00 วินาที
export function buildBangkokDateSpanRange(
  dateFrom?: string,
  dateTo?: string,
  timeFrom?: string,
  timeTo?: string
): { startAt?: Date; endAt?: Date } {
  const MINUTE_MS = 60 * 1000;

  return {
    ...(dateFrom && {
      startAt: new Date(`${dateFrom}T${timeFrom ?? "00:00"}:00.000+07:00`),
    }),
    ...(dateTo && {
      endAt: timeTo
        ? new Date(
            new Date(`${dateTo}T${timeTo}:00.000+07:00`).getTime() + MINUTE_MS
          )
        : new Date(
            new Date(`${dateTo}T00:00:00.000+07:00`).getTime() + DAY_MS
          ),
    }),
  };
}

// Function จัดรูปแบบ bangkok date สำหรับ helper กลาง
export function formatBangkokDate(value: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: BANGKOK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  return `${year}-${month}-${day}`;
}

export function formatBangkokDisplayDate(value: Date | string | null | undefined): string {
  if (!value) {
    return "-";
  }

  const date = value instanceof Date ? value : new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return "-";
  }

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: BANGKOK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;

  return `${day}/${month}/${year}`;
}

export function formatBangkokDisplayDateTime(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: BANGKOK_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  const hour = parts.find((part) => part.type === "hour")?.value;
  const minute = parts.find((part) => part.type === "minute")?.value;
  const second = parts.find((part) => part.type === "second")?.value;

  return `${day}/${month}/${year} ${hour}:${minute}:${second}`;
}

// Function คำนวณเวลาพักที่เหลือสำหรับ response หน้า status ของ Worker
export function buildRemainingBreakTime(
  breakUntil: string | null | undefined
): WorkerStatusResponse["remaining_break_time"] | null {
  if (!breakUntil) {
    return null;
  }

  const breakUntilMs = new Date(breakUntil).getTime();

  if (Number.isNaN(breakUntilMs)) {
    return null;
  }

  const totalSeconds = Math.max(
    0,
    Math.ceil((breakUntilMs - Date.now()) / 1000)
  );
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const textParts = [
    minutes > 0 ? `${minutes} ${minutes === 1 ? "minute" : "minutes"}` : null,
    seconds > 0 || minutes === 0
      ? `${seconds} ${seconds === 1 ? "second" : "seconds"}`
      : null,
  ].filter((part): part is string => Boolean(part));

  return {
    total_seconds: totalSeconds,
    minutes,
    seconds,
    text: textParts.join(" "),
  };
}
